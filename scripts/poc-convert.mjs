#!/usr/bin/env node
// MP4 to IFO — Phase 2 PoC.
//
//   MP4 -> ffprobe -> FFmpeg 2-pass (MPEG-2 / AC-3) -> dvdauthor -> VIDEO_TS
//       -> VIDEO_TS.zip + ISO (mkisofs -dvd-video) -> software verification
//
// Proof of concept only. This is not the Phase 3 Core.
// No npm dependencies. Requires on PATH:
//   ffmpeg ffprobe dvdauthor mkisofs isoinfo zip unzip hdiutil
//
// Usage: node scripts/poc-convert.mjs <input.mp4> [--output <dir>] [--keep-temp] [--verbose] [--fps-mode field|frame]

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- PoC parameters (see docs/poc.md for rationale; not final) -------------

// DVD+R SL is the smaller single-layer disc: 2,295,104 sectors = 4,700,372,992 bytes.
// Target leaves ~150 MB for filesystem/IFO (~1 MB measured), rate-control error (<= 0.05% measured)
// and content not covered by the samples.
const TARGET_USABLE_BYTES = 4_550_000_000;
// Measured PS overhead (packs, PES headers, NAV packs): 3.17% at 2 Mbps .. 1.71% at 8 Mbps,
// i.e. about 1.16% of the stream + 45 kbps. Modelled slightly high.
const MUX_OVERHEAD_RATIO = 0.012;
const MUX_OVERHEAD_KBPS = 50;
const VIDEO_MAX_AVG_KBPS = 8000;
const VIDEO_MAXRATE_KBPS = 9000; // + audio stays under the 9.8 Mbps A/V limit
const VBV_BUFSIZE_BITS = 1_835_008; // 224 KiB, MPEG-2 MP@ML
const GOP_FRAMES = 18; // NTSC max 36 fields per GOP
const AUDIO_KBPS = 256;
const LOW_VIDEO_KBPS = 3500; // warning only (between DVD-recorder SP ~4.6 and LP ~2.3 Mbps)
const MIN_VIDEO_KBPS = 1000; // refuse: does not fit a single-layer disc in any usable quality
const NTSC_FPS = 30000 / 1001;
const AC3_FRAME_S = 1536 / 48000;
const DURATION_TOLERANCE_S = 0.15; // measured max 0.058 s; a lost VOBU is >= ~0.5 s
const VOB_MAX_BYTES = 1024 ** 3;

// --- errors / process helpers ----------------------------------------------

const EXIT = {
  PREFLIGHT_FAILED: 1,
  INPUT_INVALID: 2,
  ANALYZE_FAILED: 2,
  UNSUPPORTED_INPUT: 2,
  ENCODE_FAILED: 1,
  AUTHOR_FAILED: 1,
  ISO_FAILED: 1,
  ZIP_FAILED: 1,
  OUTPUT_FAILED: 1,
  VERIFY_FAILED: 3,
  SOURCE_MODIFIED: 3,
  CANCELLED: 4,
};

class PhaseError extends Error {
  constructor(code, message, detail = '') {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

let verbose = false;
let cancelled = false;
process.on('SIGINT', () => {
  cancelled = true; // children receive SIGINT from the terminal; cleanup runs in finally
});
process.on('SIGTERM', () => {
  cancelled = true;
});

function run(code, cmd, args, { cwd, env, log } = {}) {
  if (verbose) console.log(`  $ ${[cmd, ...args].map(shellQuote).join(' ')}`);
  const r = spawnSync(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (log) fs.appendFileSync(log, `$ ${[cmd, ...args].join(' ')}\n${r.stdout ?? ''}${r.stderr ?? ''}\n`);
  if (cancelled) throw new PhaseError('CANCELLED', 'Cancelled by user');
  if (r.error) throw new PhaseError(code, `${cmd} could not be started: ${r.error.message}`);
  if (r.status !== 0) {
    throw new PhaseError(code, `${cmd} exited with ${r.status ?? r.signal}`, tail(r.stderr || r.stdout));
  }
  return r;
}

function shellQuote(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function tail(text, lines = 20) {
  return String(text ?? '').trim().split('\n').slice(-lines).join('\n');
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(8 * 1024 * 1024);
  let n;
  while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  fs.closeSync(fd);
  return hash.digest('hex');
}

function mb(bytes) {
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

function parseRate(r) {
  const [n, d] = String(r ?? '0/1').split('/').map(Number);
  return d ? n / d : 0;
}

// --- naming -----------------------------------------------------------------

function safeBaseName(input) {
  const name = path
    .parse(input)
    .name.replace(/[/\\:\x00-\x1f\x7f]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  return name || 'dvd';
}

function volumeLabel(input) {
  const label = path
    .parse(input)
    .name.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);
  return label || 'DVD_VIDEO';
}

function uniqueDir(parent, name) {
  for (let i = 1; ; i++) {
    const candidate = path.join(parent, i === 1 ? name : `${name}-${i}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

// --- analysis ---------------------------------------------------------------

function analyze(input, logs) {
  const r = run('ANALYZE_FAILED', 'ffprobe', [
    '-v', 'error', '-count_packets', '-show_format', '-show_streams', '-of', 'json', input,
  ], { log: logs });
  let probe;
  try {
    probe = JSON.parse(r.stdout);
  } catch {
    throw new PhaseError('ANALYZE_FAILED', 'ffprobe output could not be parsed');
  }
  const streams = probe.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!video) throw new PhaseError('INPUT_INVALID', 'No video stream found');
  const audios = streams.filter((s) => s.codec_type === 'audio');
  const audio = audios.find((s) => s.disposition?.default) ?? audios[0];
  const subtitles = streams.filter((s) => s.codec_type === 'subtitle');
  // Truncated files with the moov atom up front still probe fine; compare declared vs readable samples.
  for (const s of [video, audio].filter(Boolean)) {
    if (Number(s.nb_frames) > 0 && Number(s.nb_read_packets) < Number(s.nb_frames)) {
      throw new PhaseError('INPUT_INVALID', `Incomplete MP4: ${s.codec_type} has ${s.nb_read_packets} of ${s.nb_frames} samples`);
    }
  }

  const rotation = Number(video.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0);
  const sar = video.sample_aspect_ratio && video.sample_aspect_ratio !== '0:1' ? video.sample_aspect_ratio : '1:1';
  const duration = Number(video.duration ?? probe.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new PhaseError('INPUT_INVALID', 'Duration unavailable');

  const transfer = video.color_transfer ?? 'unknown';
  const hdr = !!(['smpte2084', 'arib-std-b67'].includes(transfer) ||
    video.side_data_list?.some((d) => /DOVI/i.test(d.side_data_type ?? '')));

  return {
    format: probe.format?.format_name,
    duration,
    video: {
      index: video.index,
      codec: video.codec_name,
      profile: video.profile,
      width: video.width,
      height: video.height,
      sar,
      dar: video.display_aspect_ratio ?? 'unknown',
      fps: parseRate(video.avg_frame_rate) || parseRate(video.r_frame_rate),
      rFrameRate: video.r_frame_rate,
      avgFrameRate: video.avg_frame_rate,
      pixFmt: video.pix_fmt,
      fieldOrder: video.field_order ?? 'unknown',
      colorSpace: video.color_space ?? 'unknown',
      colorTransfer: transfer,
      colorPrimaries: video.color_primaries ?? 'unknown',
      colorRange: video.color_range ?? 'unknown',
      rotation,
      hdr,
    },
    audio: audio && {
      index: audio.index,
      codec: audio.codec_name,
      sampleRate: Number(audio.sample_rate),
      channels: audio.channels,
      layout: audio.channel_layout ?? 'unknown',
      duration: Number(audio.duration ?? duration),
    },
    audioTrackCount: audios.length,
    subtitleCount: subtitles.length,
  };
}

// Top field of frame 2n + bottom field of frame 2n+1 at 59.94 fields/s. Bit-identical to
// tinterlace=interleave_top, but tinterlace is GPL-only while these filters are LGPL. weave stamps
// each frame with its second field's time (+1/2 frame); the trailing fps rounds that down to the
// first field's time (round=near would delay video by one frame) and gives pass 1 and pass 2 the
// same frame count.
const WEAVE_60I = "fps=60000/1001,setfield=tff,separatefields,select='not(mod(n\\,4))+eq(mod(n\\,4)\\,3)',weave=first_field=top,fps=30000/1001:round=down,setfield=tff";

// --fps-mode (see docs/poc.md):
//   field — default. 24/23.976 hard 3:2 telecine; every other rate except 29.97/30 (incl. VFR) to 59.94 fields (60i)
//   frame — comparison only: every rate to 29.97 whole frames with the fps filter
function frameRatePlan(fps, mode = 'field') {
  const near = (x) => Math.abs(fps - x) < 0.01;
  const film = near(24000 / 1001) || near(24);
  if (mode === 'frame') return { filter: 'fps=30000/1001', note: `${fps.toFixed(3)} -> 29.97 frames (fps filter)` };
  if (near(NTSC_FPS)) return { filter: null, note: '29.97 -> 29.97 (no conversion)' };
  if (near(30)) return { filter: 'fps=30000/1001', note: '30 -> 29.97 (fps filter, drops 1 frame per 1001)' };
  if (near(60000 / 1001) || near(60) || (mode === 'field' && (near(25) || near(50)))) {
    return { filter: WEAVE_60I, note: `${fps.toFixed(3)} -> 59.94 fields, 29.97 interlaced TFF` };
  }
  if (film) return { filter: 'fps=24000/1001,telecine=first_field=top:pattern=23', note: `${fps.toFixed(3)} -> 29.97 hard 3:2 telecine` };
  if (mode === 'field') return { filter: WEAVE_60I, note: `${fps.toFixed(3)} (other/VFR) -> 59.94 fields, 29.97 interlaced TFF` };
  return null;
}

// --- bitrate ----------------------------------------------------------------

function videoBitrateKbps(duration) {
  const muxedKbps = (TARGET_USABLE_BYTES * 8 / duration / 1000 - MUX_OVERHEAD_KBPS) / (1 + MUX_OVERHEAD_RATIO);
  return Math.min(VIDEO_MAX_AVG_KBPS, Math.floor(muxedKbps - AUDIO_KBPS));
}

// --- encode -----------------------------------------------------------------

function videoFilter(info, fpsPlan) {
  const v = info.video;
  const inMatrix =
    v.colorSpace === 'bt709' ? 'bt709'
      : ['smpte170m', 'bt470bg'].includes(v.colorSpace) ? 'bt601'
        : v.height >= 720 ? 'bt709' : 'bt601'; // untagged: assume by resolution
  // Fit the display aspect into a 16:9 DVD frame (720x480, SAR 32:27) without crop or stretch.
  // `dar` here is after ffmpeg's autorotate, so rotated sources are handled.
  const fit = 'gte(dar,16/9-0.001)';
  return [
    `scale=w='if(${fit},720,2*trunc(720*dar/(16/9)/2))':h='if(${fit},2*trunc(480*(16/9)/dar/2),480)'` +
      `:in_color_matrix=${inMatrix}:out_color_matrix=bt601:out_range=tv:flags=lanczos`,
    'pad=720:480:(ow-iw)/2:(oh-ih)/2:black',
    fpsPlan.filter,
    'setsar=32/27',
    'format=yuv420p',
  ].filter(Boolean).join(',');
}

// Stereo downmix without ffmpeg's defaults: -ac 2 puts mono at -3 dB, and its 5.1 matrix is
// normalised or not depending on the negotiated sample format (unnormalised for the AC-3 encoder,
// which clips). ITU-R BS.775 Lo/Ro (C and surrounds at -3 dB, LFE omitted), then a static gain that
// only attenuates, so the downmix peaks at -1 dBFS at most. Not loudness normalisation.
function audioFilter(input, info, logs) {
  const a = info.audio;
  if (!a || a.channels === 2) return { filter: null, note: 'as is' };
  if (a.channels === 1) return { filter: 'pan=stereo|c0=c0|c1=c0', note: 'mono -> L=R (unity)' };
  const surround = { '5.1': ['BL', 'BR'], '5.1(side)': ['SL', 'SR'] }[a.layout];
  const matrix = surround
    ? `pan=stereo|FL=FL+0.7071*FC+0.7071*${surround[0]}|FR=FR+0.7071*FC+0.7071*${surround[1]}`
    : 'aformat=sample_fmts=fltp,aresample=ochl=stereo,aformat=sample_fmts=fltp'; // other layouts: ffmpeg matrix, float
  const r = run('ENCODE_FAILED', 'ffmpeg', ['-hide_banner', '-nostdin', '-v', 'info', '-i', input, '-map', `0:${a.index}`,
    '-af', `${matrix},astats=measure_perchannel=none:measure_overall=Peak_level`, '-f', 'null', '-'], { log: logs });
  const peak = Number(/Peak level dB: (-?[\d.]+|-?inf)/.exec(r.stderr)?.[1] ?? 0);
  const gain = Math.min(0, -1 - peak);
  return {
    filter: gain < 0 ? `${matrix},volume=${gain.toFixed(2)}dB` : matrix,
    note: `${a.layout} -> stereo ${surround ? 'ITU Lo/Ro' : '(ffmpeg matrix)'}, downmix peak ${peak.toFixed(1)} dBFS, gain ${gain.toFixed(2)} dB`,
  };
}

function encode(input, info, fpsPlan, videoKbps, work, logs, af) {
  const vf = videoFilter(info, fpsPlan);
  const passlog = path.join(work, 'pass');
  const videoArgs = [
    '-map', `0:${info.video.index}`,
    '-vf', vf,
    '-c:v', 'mpeg2video',
    '-b:v', `${videoKbps}k`,
    '-maxrate', `${VIDEO_MAXRATE_KBPS}k`,
    '-minrate', '0',
    '-bufsize', String(VBV_BUFSIZE_BITS),
    '-g', String(GOP_FRAMES),
    '-bf', '2',
    '-flags', '+ildct+ilme', // progressive_sequence=0, as DVD-Video requires
    '-top', '1',
    '-aspect', '16:9',
    '-color_primaries', 'smpte170m',
    '-color_trc', 'smpte170m',
    '-colorspace', 'smpte170m',
    '-passlogfile', passlog,
  ];
  const base = ['-hide_banner', '-nostdin', '-v', 'error', '-y'];

  console.log('  pass 1/2');
  run('ENCODE_FAILED', 'ffmpeg', [...base, '-i', input, ...videoArgs, '-pass', '1', '-an', '-f', 'null', '-'], {
    cwd: work, log: logs,
  });

  const audioIn = info.audio
    ? []
    : ['-f', 'lavfi', '-t', String(info.duration), '-i', 'anullsrc=r=48000:cl=stereo'];
  const audioMap = info.audio ? ['-map', `0:${info.audio.index}`] : ['-map', '1:a'];
  const out = path.join(work, 'title.mpg');
  console.log('  pass 2/2');
  run('ENCODE_FAILED', 'ffmpeg', [
    ...base, '-i', input, ...audioIn,
    ...videoArgs, '-pass', '2',
    ...audioMap,
    ...(af ? ['-af', af] : []),
    '-c:a', 'ac3', '-b:a', `${AUDIO_KBPS}k`, '-ar', '48000', '-ac', '2',
    '-map_metadata', '-1', '-map_chapters', '-1',
    '-f', 'dvd', '-muxrate', '10080000', '-packetsize', '2048',
    out,
  ], { cwd: work, log: logs });
  return { out, vf };
}

// --- author -----------------------------------------------------------------

function author(mpg, work, logs) {
  const xml = `<dvdauthor dest="dvd">
  <vmgm>
    <fpc>jump title 1;</fpc>
  </vmgm>
  <titleset>
    <titles>
      <video format="ntsc" aspect="16:9" widescreen="nopanscan"/>
      <audio format="ac3" channels="2" samplerate="48khz"/>
      <pgc>
        <vob file="${path.basename(mpg)}"/>
        <post>exit;</post>
      </pgc>
    </titles>
  </titleset>
</dvdauthor>
`;
  fs.writeFileSync(path.join(work, 'dvdauthor.xml'), xml);
  run('AUTHOR_FAILED', 'dvdauthor', ['-x', 'dvdauthor.xml'], { cwd: work, env: { VIDEO_FORMAT: 'NTSC' }, log: logs });
  const dvdRoot = path.join(work, 'dvd');
  if (!fs.existsSync(path.join(dvdRoot, 'VIDEO_TS', 'VIDEO_TS.IFO'))) {
    throw new PhaseError('AUTHOR_FAILED', 'dvdauthor finished without VIDEO_TS.IFO');
  }
  fs.rmSync(mpg); // intermediate no longer needed
  return dvdRoot;
}

// --- IFO parsing ------------------------------------------------------------

const bcd = (b) => (b >> 4) * 10 + (b & 15);

function pgcInfo(buf, pgcOffset) {
  const t = buf.subarray(pgcOffset + 4, pgcOffset + 8);
  const fpsCode = t[3] >> 6;
  const frameRate = fpsCode === 3 ? NTSC_FPS : fpsCode === 1 ? 25 : 0;
  // BCD timecode counts frames non-drop at the nominal rate (30 for NTSC), so convert via frame count.
  const nominal = fpsCode === 3 ? 30 : 25;
  const frames = (bcd(t[0]) * 3600 + bcd(t[1]) * 60 + bcd(t[2])) * nominal + bcd(t[3] & 0x3f);
  const seconds = frameRate ? frames / frameRate : 0;
  const programs = buf[pgcOffset + 2];
  const cells = buf[pgcOffset + 3];
  const cmdOff = buf.readUInt16BE(pgcOffset + 0xe4);
  const cmds = { pre: [], post: [], cell: [] };
  if (cmdOff) {
    const c = pgcOffset + cmdOff;
    const counts = [buf.readUInt16BE(c), buf.readUInt16BE(c + 2), buf.readUInt16BE(c + 4)];
    let p = c + 8;
    for (const [i, key] of ['pre', 'post', 'cell'].entries()) {
      for (let k = 0; k < counts[i]; k++, p += 8) cmds[key].push(decodeCmd(buf.subarray(p, p + 8)));
    }
  }
  return { seconds, fpsCode, programs, cells, cmds };
}

function decodeCmd(c) {
  if (c[0] === 0x30 && c[1] === 0x01) return 'Exit';
  if (c[0] === 0x30 && c[1] === 0x02) return `JumpTT ${c[5]}`;
  return c.toString('hex');
}

function parseVmg(file) {
  const b = fs.readFileSync(file);
  const id = b.toString('latin1', 0, 12);
  const lastSector = b.readUInt32BE(0x0c);
  const titleSets = b.readUInt16BE(0x3e);
  const fp = b.readUInt32BE(0x84);
  const ttSrpt = b.readUInt32BE(0xc4) * 2048;
  const titles = [];
  for (let i = 0, n = b.readUInt16BE(ttSrpt); i < n; i++) {
    const e = ttSrpt + 8 + i * 12;
    titles.push({ chapters: b.readUInt16BE(e + 2), vts: b[e + 6], vtsTitle: b[e + 7], vtsStartSector: b.readUInt32BE(e + 8) });
  }
  const regionMask = b[0x23]; // bit set = playback prohibited in that region
  return { id, lastSector, titleSets, regionMask, firstPlay: fp ? pgcInfo(b, fp) : null, titles };
}

function parseVts(file) {
  const b = fs.readFileSync(file);
  const v = b.subarray(0x200, 0x202);
  const audioCount = b.readUInt16BE(0x202);
  const audio = [];
  for (let i = 0; i < audioCount; i++) {
    const a = b.subarray(0x204 + i * 8, 0x20c + i * 8);
    audio.push({ coding: ['ac3', '?', 'mpeg1', 'mpeg2ext', 'lpcm', '?', 'dts', '?'][a[0] >> 5], sampleRate: (a[1] >> 4) & 3 ? 'other' : 48000, channels: (a[1] & 7) + 1 });
  }
  const pgcit = b.readUInt32BE(0xcc) * 2048;
  const pgcs = [];
  for (let i = 0, n = b.readUInt16BE(pgcit); i < n; i++) pgcs.push(pgcInfo(b, pgcit + b.readUInt32BE(pgcit + 8 + i * 8 + 4)));
  return {
    id: b.toString('latin1', 0, 12),
    lastSector: b.readUInt32BE(0x0c),
    ifoLastSector: b.readUInt32BE(0x1c),
    titleVobStart: b.readUInt32BE(0xc4),
    video: {
      mpeg: ['MPEG-1', 'MPEG-2'][v[0] >> 6] ?? '?',
      standard: ['NTSC', 'PAL'][(v[0] >> 4) & 3] ?? '?',
      aspect: { 0: '4:3', 3: '16:9' }[(v[0] >> 2) & 3] ?? '?',
      resolution: ['720x480', '704x480', '352x480', '352x240'][(v[1] >> 3) & 7] ?? '?',
    },
    audio,
    pgcs,
  };
}

// --- VOB bitstream scan -----------------------------------------------------

// Walk 2048-byte PS packs: count NAV packs, check AC-3 PES PTS monotonicity,
// and scan the MPEG-2 video payload for sequence/GOP/picture headers.
function scanVobs(files) {
  const pack = Buffer.alloc(2048);
  const r = { packs: 0, navPacks: 0, audioPts: 0, audioPtsNonMonotonic: 0, seq: null, progressiveSequence: null, pictures: 0, maxGop: 0, badPacks: 0 };
  let lastAudioPts = -1;
  let gop = 0;
  let carry = Buffer.alloc(0);
  const pts = (b, p) => ((b[p] >> 1) & 7) * 2 ** 30 + ((b.readUInt16BE(p + 1) >> 1) << 15) + (b.readUInt16BE(p + 3) >> 1);
  const scanVideo = (payload) => {
    const b = Buffer.concat([carry, payload]);
    const end = b.length - 12;
    for (let i = 0; i < end; i++) {
      if (b[i] !== 0 || b[i + 1] !== 0 || b[i + 2] !== 1) continue;
      const c = b[i + 3];
      if (c === 0xb3 && !r.seq) {
        r.seq = { width: (b[i + 4] << 4) | (b[i + 5] >> 4), height: ((b[i + 5] & 15) << 8) | b[i + 6], aspectCode: b[i + 7] >> 4, frameRateCode: b[i + 7] & 15, vbvKbit: (((b[i + 10] & 31) << 5) | (b[i + 11] >> 3)) * 16 };
      } else if (c === 0xb5 && b[i + 4] >> 4 === 1 && r.progressiveSequence === null) {
        r.progressiveSequence = (b[i + 5] >> 3) & 1;
      } else if (c === 0xb8) {
        r.maxGop = Math.max(r.maxGop, gop);
        gop = 0;
      } else if (c === 0x00) {
        r.pictures++;
        gop++;
      }
    }
    carry = b.subarray(Math.max(0, end));
  };
  for (const file of files) {
    const fd = fs.openSync(file, 'r');
    while (fs.readSync(fd, pack, 0, 2048, null) === 2048) {
      r.packs++;
      if (pack.readUInt32BE(0) !== 0x1ba) {
        r.badPacks++;
        continue;
      }
      let p = 14 + (pack[13] & 7);
      while (p + 6 <= 2048 && pack.readUInt32BE(p) >>> 8 === 1) {
        const id = pack[p + 3];
        const len = pack.readUInt16BE(p + 4);
        if (id === 0xbf) r.navPacks += 0.5; // PCI + DSI
        if (id === 0xe0 || id === 0xbd) {
          const hl = pack[p + 8];
          const payload = pack.subarray(p + 9 + hl, p + 6 + len);
          if (id === 0xe0) scanVideo(payload);
          else if (pack[p + 9 + hl] === 0x80 && pack[p + 7] & 0x80) {
            const t = pts(pack, p + 9);
            r.audioPts++;
            if (t <= lastAudioPts) r.audioPtsNonMonotonic++;
            lastAudioPts = t;
          }
        }
        p += 6 + len;
      }
    }
    fs.closeSync(fd);
  }
  r.maxGop = Math.max(r.maxGop, gop);
  return r;
}

// --- verification -----------------------------------------------------------

function listVideoTs(dir) {
  return fs.readdirSync(dir).filter((f) => !f.startsWith('.')).sort();
}

function verify(ctx) {
  const { info, stage, isoPath, zipPath, work, logs } = ctx;
  const videoTs = path.join(stage, 'VIDEO_TS');
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  // 1. VIDEO_TS structure
  const files = listVideoTs(videoTs);
  const vobs = files.filter((f) => /^VTS_01_[1-9]\.VOB$/.test(f));
  const required = ['VIDEO_TS.IFO', 'VIDEO_TS.BUP', 'VTS_01_0.IFO', 'VTS_01_0.BUP'];
  check('VIDEO_TS required files', required.every((f) => files.includes(f)) && vobs.length > 0, files.join(' '));
  const unexpected = files.filter((f) => !required.includes(f) && !vobs.includes(f));
  check('VIDEO_TS has no unexpected files', unexpected.length === 0, unexpected.join(' '));
  const sizes = Object.fromEntries(files.map((f) => [f, fs.statSync(path.join(videoTs, f)).size]));
  check('file sizes are whole 2048-byte sectors, VOBs non-empty and <= 1 GiB',
    files.every((f) => sizes[f] % 2048 === 0) && vobs.every((f) => sizes[f] > 0 && sizes[f] <= VOB_MAX_BYTES),
    vobs.map((f) => `${f} ${mb(sizes[f])}`).join(', '));
  const bupMatch = ['VIDEO_TS', 'VTS_01_0'].every((n) =>
    fs.readFileSync(path.join(videoTs, `${n}.IFO`)).equals(fs.readFileSync(path.join(videoTs, `${n}.BUP`))));
  check('BUP files identical to IFO', bupMatch);

  // 2. IFO content
  const vmg = parseVmg(path.join(videoTs, 'VIDEO_TS.IFO'));
  const vts = parseVts(path.join(videoTs, 'VTS_01_0.IFO'));
  check('VMG identifier', vmg.id === 'DVDVIDEO-VMG', vmg.id);
  check('VTS identifier', vts.id === 'DVDVIDEO-VTS', vts.id);
  check('one title set, one title', vmg.titleSets === 1 && vmg.titles.length === 1 && vmg.titles[0].vts === 1,
    `titleSets=${vmg.titleSets} titles=${vmg.titles.length}`);
  check('Region free (VMG region mask 0x00)', vmg.regionMask === 0, `0x${vmg.regionMask.toString(16).padStart(2, '0')}`);
  check('First Play jumps to title 1', vmg.firstPlay?.cmds.pre.includes('JumpTT 1') ?? false,
    JSON.stringify(vmg.firstPlay?.cmds.pre ?? []));
  const pgc = vts.pgcs[0];
  check('title PGC ends with Exit (stop)', pgc?.cmds.post.includes('Exit') ?? false, JSON.stringify(pgc?.cmds.post ?? []));
  check('VTS video attributes: MPEG-2 / NTSC / 16:9 / 720x480',
    vts.video.mpeg === 'MPEG-2' && vts.video.standard === 'NTSC' && vts.video.aspect === '16:9' && vts.video.resolution === '720x480',
    Object.values(vts.video).join(' / '));
  check('VTS audio attributes: 1 x AC-3 / 2ch / 48 kHz',
    vts.audio.length === 1 && vts.audio[0].coding === 'ac3' && vts.audio[0].channels === 2 && vts.audio[0].sampleRate === 48000,
    JSON.stringify(vts.audio));
  const vtsSectors = (sizes['VTS_01_0.IFO'] + sizes['VTS_01_0.BUP'] + vobs.reduce((s, f) => s + sizes[f], 0)) / 2048;
  check('VTS last sector matches file sizes', vts.lastSector + 1 === vtsSectors, `${vts.lastSector + 1} vs ${vtsSectors}`);
  check('title VOBS starts right after VTS IFO', vts.titleVobStart === sizes['VTS_01_0.IFO'] / 2048, String(vts.titleVobStart));

  // 3. MPEG-2 / PS bitstream
  const vobPaths = vobs.map((f) => path.join(videoTs, f));
  const scan = scanVobs(vobPaths);
  check('all packs are 2048-byte MPEG-2 PS packs', scan.badPacks === 0, `${scan.packs} packs`);
  check('NAV packs present', scan.navPacks > 0, `${scan.navPacks} (one per VOBU)`);
  check('sequence header: 720x480, 16:9 (code 3), 29.97 (code 4), VBV <= 224 KiB',
    scan.seq?.width === 720 && scan.seq?.height === 480 && scan.seq?.aspectCode === 3 && scan.seq?.frameRateCode === 4 && scan.seq?.vbvKbit <= 1792,
    JSON.stringify(scan.seq));
  check('progressive_sequence = 0', scan.progressiveSequence === 0, String(scan.progressiveSequence));
  check(`GOP <= ${GOP_FRAMES} frames`, scan.maxGop > 0 && scan.maxGop <= GOP_FRAMES, `max ${scan.maxGop}`);
  check('AC-3 PES PTS strictly increasing', scan.audioPtsNonMonotonic === 0, `${scan.audioPts} PTS`);

  // 4. streams + full decode (ffprobe -count_frames decodes every frame; no muxer involved)
  const concat = `concat:${vobPaths.join('|')}`;
  const probe = spawnSync('ffprobe', ['-v', 'error', '-err_detect', 'crccheck', '-count_frames',
    '-show_entries', 'stream=codec_type,codec_name,width,height,sample_aspect_ratio,display_aspect_ratio,r_frame_rate,sample_rate,channels,nb_read_frames',
    '-of', 'json', concat], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (cancelled) throw new PhaseError('CANCELLED', 'Cancelled by user');
  fs.appendFileSync(logs, `$ ffprobe -count_frames ${concat}\n${probe.stdout}${probe.stderr}\n`);
  const streams = probe.status === 0 ? JSON.parse(probe.stdout).streams : [];
  const v = streams.filter((s) => s.codec_type === 'video');
  const a = streams.filter((s) => s.codec_type === 'audio');
  check('full decode: no decoder errors', probe.status === 0 && probe.stderr.trim() === '', tail(probe.stderr, 5));
  check('streams: 1 x mpeg2video 720x480 SAR 32:27 DAR 16:9 30000/1001',
    v.length === 1 && v[0].codec_name === 'mpeg2video' && v[0].width === 720 && v[0].height === 480 &&
    v[0].sample_aspect_ratio === '32:27' && v[0].display_aspect_ratio === '16:9' && v[0].r_frame_rate === '30000/1001');
  check('streams: 1 x ac3 48000 Hz 2ch', a.length === 1 && a[0].codec_name === 'ac3' && a[0].sample_rate === '48000' && a[0].channels === 2);

  // 5. durations
  const videoDur = Number(v[0]?.nb_read_frames ?? 0) / NTSC_FPS;
  const audioDur = Number(a[0]?.nb_read_frames ?? 0) * AC3_FRAME_S;
  const durations = {
    source: info.duration,
    sourceAudio: info.audio?.duration ?? null,
    dvdVideoDecoded: videoDur,
    dvdAudioDecoded: audioDur,
    ifoPgc: pgc?.seconds ?? 0,
  };
  ctx.durations = durations;
  const d = (x) => Math.abs(x - info.duration);
  check(`decoded video duration within ${DURATION_TOLERANCE_S}s of source`, d(videoDur) <= DURATION_TOLERANCE_S,
    `${videoDur.toFixed(3)}s vs ${info.duration.toFixed(3)}s (Δ ${(videoDur - info.duration).toFixed(3)}s, ${v[0]?.nb_read_frames} frames)`);
  check(`decoded audio duration within ${DURATION_TOLERANCE_S}s of source`, d(audioDur) <= DURATION_TOLERANCE_S,
    `${audioDur.toFixed(3)}s (Δ ${(audioDur - info.duration).toFixed(3)}s, ${a[0]?.nb_read_frames} AC-3 frames)`);
  check(`IFO playback time within ${DURATION_TOLERANCE_S}s of source`, d(durations.ifoPgc) <= DURATION_TOLERANCE_S,
    `${durations.ifoPgc.toFixed(3)}s`);

  // 6. ZIP
  const hashes = Object.fromEntries(files.map((f) => [f, sha256(path.join(videoTs, f))]));
  const zt = spawnSync('unzip', ['-tq', zipPath], { encoding: 'utf8' });
  check('ZIP integrity (unzip -t)', zt.status === 0, zt.stdout.trim());
  const entries = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).stdout.trim().split('\n').sort();
  const expected = ['VIDEO_TS/', ...files.map((f) => `VIDEO_TS/${f}`)].sort();
  check('ZIP entries are exactly VIDEO_TS/*', JSON.stringify(entries) === JSON.stringify(expected), entries.join(' '));
  const unz = path.join(work, 'unzipped');
  spawnSync('unzip', ['-q', zipPath, '-d', unz]);
  const zipOk = files.every((f) => fs.existsSync(path.join(unz, 'VIDEO_TS', f)) && sha256(path.join(unz, 'VIDEO_TS', f)) === hashes[f]);
  check('ZIP extracted content identical to VIDEO_TS (sha256)', zipOk);
  fs.rmSync(unz, { recursive: true, force: true });

  // 7. ISO
  const pvd = spawnSync('isoinfo', ['-d', '-i', isoPath], { encoding: 'utf8' }).stdout;
  const volId = /Volume id:\s*(.*)/.exec(pvd)?.[1]?.trim();
  check('ISO9660 volume id', volId === ctx.label, volId);
  const fd = fs.openSync(isoPath, 'r');
  const sec = Buffer.alloc(2048);
  const vrs = [];
  for (let s = 16; s < 32; s++) {
    fs.readSync(fd, sec, 0, 2048, s * 2048);
    const id = sec.toString('latin1', 1, 6);
    if (!/^[A-Z0-9]{5}$/.test(id)) break;
    vrs.push(id);
  }
  fs.readSync(fd, sec, 0, 2048, 256 * 2048);
  const avdp = sec.readUInt16LE(0) === 2;
  fs.closeSync(fd);
  check('ISO has ISO9660 + UDF (NSR02) bridge', vrs.includes('CD001') && vrs.includes('NSR02') && avdp, `${vrs.join(' ')} AVDP=${avdp}`);

  const listing = spawnSync('isoinfo', ['-l', '-i', isoPath], { encoding: 'utf8' }).stdout;
  const lba = {};
  for (const m of listing.matchAll(/\[\s*(\d+)\s+\d+\]\s+(\S+?)(?:;1)?\s*$/gm)) lba[m[2]] = Number(m[1]);
  const order = ['VIDEO_TS.IFO', 'VIDEO_TS.BUP', 'VTS_01_0.IFO', ...vobs, 'VTS_01_0.BUP'];
  const ascending = order.every((f, i) => lba[f] !== undefined && (i === 0 || lba[f] > lba[order[i - 1]]));
  check('ISO file order: VMG IFO < BUP < VTS IFO < VOBs < VTS BUP', ascending, order.map((f) => `${f}@${lba[f]}`).join(' '));
  const vtsOffset = lba['VTS_01_0.IFO'] - lba['VIDEO_TS.IFO'];
  check('ISO layout matches IFO sector addresses',
    vmg.titles[0]?.vtsStartSector === vtsOffset &&
      lba[vobs[0]] - lba['VTS_01_0.IFO'] === vts.titleVobStart &&
      lba['VTS_01_0.BUP'] === lba['VTS_01_0.IFO'] + vts.lastSector + 1 - sizes['VTS_01_0.BUP'] / 2048 &&
      lba['VIDEO_TS.BUP'] === lba['VIDEO_TS.IFO'] + vmg.lastSector + 1 - sizes['VIDEO_TS.BUP'] / 2048,
    `TT_SRPT VTS start=${vmg.titles[0]?.vtsStartSector}, ISO offset=${vtsOffset}`);

  const mnt = path.join(work, 'mnt');
  fs.mkdirSync(mnt);
  const attach = spawnSync('hdiutil', ['attach', '-readonly', '-nobrowse', '-noverify', '-mountpoint', mnt, isoPath], { encoding: 'utf8' });
  ctx.mounted = attach.status === 0 ? mnt : null;
  check('ISO mounts on macOS (hdiutil, read-only)', attach.status === 0, tail(attach.stderr, 3));
  if (ctx.mounted) {
    const fsType = /\((\w+),/.exec(spawnSync('mount', { encoding: 'utf8' }).stdout.split('\n').find((l) => l.includes(` on ${fs.realpathSync(mnt)} `)) ?? '')?.[1];
    check('mounted filesystem', fsType === 'udf', fsType);
    const isoFiles = fs.existsSync(path.join(mnt, 'VIDEO_TS')) ? listVideoTs(path.join(mnt, 'VIDEO_TS')) : [];
    check('ISO contains VIDEO_TS with the same files', JSON.stringify(isoFiles) === JSON.stringify(files), isoFiles.join(' '));
    const same = files.every((f) => isoFiles.includes(f) && sha256(path.join(mnt, 'VIDEO_TS', f)) === hashes[f]);
    check('ISO VIDEO_TS content identical (sha256)', same);
    const isoProbe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', path.join(mnt, 'VIDEO_TS', vobs[0])], { encoding: 'utf8' });
    check('ISO VOB readable by ffprobe', isoProbe.status === 0 && /mpeg2video/.test(isoProbe.stdout) && /ac3/.test(isoProbe.stdout),
      isoProbe.stdout.trim().split('\n').join(' '));
    spawnSync('hdiutil', ['detach', mnt, '-quiet']);
    ctx.mounted = null;
  }

  ctx.scan = scan;
  ctx.vts = vts;
  return results;
}

// --- main -------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { input: null, output: null, keepTemp: false, fpsMode: 'field' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--output') opts.output = argv[++i];
    else if (a === '--keep-temp') opts.keepTemp = true;
    else if (a === '--fps-mode') opts.fpsMode = argv[++i];
    else if (a === '--verbose') verbose = true;
    else if (!opts.input) opts.input = a;
    else throw new PhaseError('INPUT_INVALID', `Unexpected argument: ${a}`);
  }
  return opts;
}

function phase(name) {
  console.log(`\n== ${name}`);
  return Date.now();
}

function done(t0) {
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.input) {
    console.log('Usage: node scripts/poc-convert.mjs <input.mp4> [--output <dir>] [--keep-temp] [--verbose] [--fps-mode field|frame]');
    process.exit(EXIT.INPUT_INVALID);
  }

  let work = null;
  let stage = null;
  const ctx = {};
  let error = null;
  const started = Date.now();

  try {
    let t = phase('Preflight');
    for (const tool of ['ffmpeg', 'ffprobe', 'dvdauthor', 'mkisofs', 'isoinfo', 'zip', 'unzip', 'hdiutil']) {
      if (spawnSync('which', [tool]).status !== 0) throw new PhaseError('PREFLIGHT_FAILED', `Required tool not found: ${tool}`);
    }
    const input = path.resolve(opts.input);
    const st = fs.existsSync(input) ? fs.statSync(input) : null;
    if (!st?.isFile()) throw new PhaseError('INPUT_INVALID', 'Input file not found');
    if (path.extname(input).toLowerCase() !== '.mp4') throw new PhaseError('INPUT_INVALID', 'Input must be an .mp4 file');
    const outParent = path.resolve(opts.output ?? path.dirname(input));
    fs.mkdirSync(outParent, { recursive: true });
    fs.accessSync(outParent, fs.constants.W_OK);

    work = fs.mkdtempSync(path.join(os.tmpdir(), 'mp4-to-ifo-poc-'));
    const logs = path.join(work, 'tools.log');
    console.log(`  temp   ${work}`);
    console.log('  hashing source (read-only)...');
    const sourceBefore = { size: st.size, mtimeMs: st.mtimeMs, sha256: sha256(input) };
    done(t);

    t = phase('Analyze');
    const info = analyze(input, logs);
    const v = info.video;
    console.log(`  duration    ${info.duration.toFixed(3)}s`);
    console.log(`  video       ${v.codec} ${v.profile ?? ''} ${v.width}x${v.height} SAR ${v.sar} DAR ${v.dar} ${v.fps.toFixed(3)} fps (r=${v.rFrameRate} avg=${v.avgFrameRate})`);
    console.log(`              ${v.pixFmt} ${v.fieldOrder} color=${v.colorSpace}/${v.colorTransfer}/${v.colorPrimaries} range=${v.colorRange} rotation=${v.rotation} hdr=${v.hdr}`);
    console.log(`  audio       ${info.audio ? `${info.audio.codec} ${info.audio.sampleRate} Hz ${info.audio.channels}ch ${info.audio.layout} (track ${info.audio.index} of ${info.audioTrackCount})` : 'none'}`);
    console.log(`  subtitles   ${info.subtitleCount}`);
    run('INPUT_INVALID', 'ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-t', '2', '-i', input, '-map', `0:${v.index}`, '-f', 'null', '-'], { log: logs });
    console.log('  decode test (first 2s) ok');
    if (v.hdr) throw new PhaseError('UNSUPPORTED_INPUT', `HDR input (${v.colorTransfer}) is not handled by this PoC yet`);
    const fpsPlan = frameRatePlan(v.fps, opts.fpsMode);
    if (!fpsPlan) throw new PhaseError('UNSUPPORTED_INPUT', `Frame rate ${v.fps.toFixed(3)} is not handled by this PoC yet`);
    if (!info.audio) console.log('  WARNING no audio track; a silent AC-3 track will be added');
    if (info.subtitleCount) console.log('  WARNING subtitle tracks will not be included');
    if (info.audio && info.audio.channels > 2) console.log(`  WARNING ${info.audio.channels}ch audio will be downmixed to stereo`);
    done(t);

    t = phase('DVD parameters');
    const videoKbps = videoBitrateKbps(info.duration);
    console.log(`  frame rate  ${fpsPlan.note}`);
    console.log(`  video       MPEG-2 720x480 16:9 avg ${videoKbps} kbps, max ${VIDEO_MAXRATE_KBPS} kbps, GOP ${GOP_FRAMES}, 2-pass`);
    console.log(`  audio       AC-3 ${AUDIO_KBPS} kbps stereo 48 kHz`);
    if (videoKbps < MIN_VIDEO_KBPS) throw new PhaseError('UNSUPPORTED_INPUT', `Required video bitrate ${videoKbps} kbps is too low`);
    if (videoKbps < LOW_VIDEO_KBPS) console.log(`  WARNING low video bitrate (${videoKbps} kbps)`);
    const estimate = ((videoKbps + AUDIO_KBPS) * (1 + MUX_OVERHEAD_RATIO) + MUX_OVERHEAD_KBPS) * 1000 * info.duration / 8;
    console.log(`  estimated   ${mb(estimate)} per copy (VIDEO_TS, ZIP, ISO)`);
    const free = fs.statfsSync(outParent);
    const need = estimate * 3 * 1.1;
    if (free.bavail * free.bsize < need) throw new PhaseError('INPUT_INVALID', `Not enough disk space (need ~${mb(need)})`);
    done(t);

    t = phase('Encode (FFmpeg 2-pass)');
    const audio = audioFilter(input, info, logs);
    console.log(`  audio       ${audio.note}`);
    const { out: mpg, vf } = encode(input, info, fpsPlan, videoKbps, work, logs, audio.filter);
    console.log(`  filter      ${vf}`);
    console.log(`  title.mpg   ${mb(fs.statSync(mpg).size)}`);
    done(t);

    t = phase('Author (dvdauthor)');
    const dvdRoot = author(mpg, work, logs);
    done(t);

    const name = safeBaseName(input);
    ctx.label = volumeLabel(input);
    stage = path.join(outParent, `.${name}.partial-${process.pid}`);
    fs.mkdirSync(stage);

    t = phase('ISO (mkisofs -dvd-video)');
    ctx.isoPath = path.join(stage, `${name}.iso`);
    console.log(`  volume      ${ctx.label}`);
    run('ISO_FAILED', 'mkisofs', ['-dvd-video', '-V', ctx.label, '-input-charset', 'utf-8', '-quiet', '-o', ctx.isoPath, dvdRoot], { log: logs });
    try {
      fs.renameSync(path.join(dvdRoot, 'VIDEO_TS'), path.join(stage, 'VIDEO_TS'));
    } catch (e) {
      if (e.code !== 'EXDEV') throw new PhaseError('OUTPUT_FAILED', e.message);
      fs.cpSync(path.join(dvdRoot, 'VIDEO_TS'), path.join(stage, 'VIDEO_TS'), { recursive: true });
    }
    done(t);

    if (process.env.POC_FAULT === 'corrupt-vob') {
      // Test hook: damage the authored VOB to prove verification rejects it.
      const vfd = fs.openSync(path.join(stage, 'VIDEO_TS', 'VTS_01_1.VOB'), 'r+');
      fs.writeSync(vfd, Buffer.alloc(300_000, 0x55), 0, 300_000, 4_000_000);
      fs.closeSync(vfd);
      console.log('  POC_FAULT: overwrote 300 KB of VTS_01_1.VOB');
    }

    t = phase('ZIP');
    ctx.zipPath = path.join(stage, 'VIDEO_TS.zip');
    // Store only (-0): MPEG payload does not compress meaningfully.
    run('ZIP_FAILED', 'zip', ['-r', '-X', '-0', '-q', 'VIDEO_TS.zip', 'VIDEO_TS'], { cwd: stage, log: logs });
    done(t);

    t = phase('Verify');
    Object.assign(ctx, { info, stage, work, logs });
    const results = verify(ctx);
    const after = fs.statSync(input);
    const sourceOk = after.size === sourceBefore.size && after.mtimeMs === sourceBefore.mtimeMs && sha256(input) === sourceBefore.sha256;
    console.log(`  ${sourceOk ? 'ok  ' : 'FAIL'} source MP4 unchanged (size, mtime, sha256)`);
    if (!sourceOk) throw new PhaseError('SOURCE_MODIFIED', 'Source MP4 changed during conversion');
    const failed = results.filter((r) => !r.ok);
    if (failed.length) throw new PhaseError('VERIFY_FAILED', `${failed.length} verification check(s) failed`, failed.map((f) => f.name).join('\n'));
    done(t);

    const final = uniqueDir(outParent, name);
    fs.renameSync(stage, final);
    stage = null;
    console.log('\n== Result: SUCCESS (software verification only — not physically verified on a DVD player)');
    for (const f of ['VIDEO_TS', 'VIDEO_TS.zip', `${name}.iso`]) {
      const p = path.join(final, f);
      const size = fs.statSync(p).isDirectory()
        ? listVideoTs(p).reduce((s, x) => s + fs.statSync(path.join(p, x)).size, 0)
        : fs.statSync(p).size;
      console.log(`  ${p}  ${mb(size)}`);
    }
    const dd = ctx.durations;
    console.log(`  durations   source ${dd.source.toFixed(3)}s | DVD video ${dd.dvdVideoDecoded.toFixed(3)}s | DVD audio ${dd.dvdAudioDecoded.toFixed(3)}s | IFO ${dd.ifoPgc.toFixed(3)}s`);
    console.log(`  total time  ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } catch (e) {
    error = e instanceof PhaseError ? e : new PhaseError('OUTPUT_FAILED', e.message, e.stack);
  } finally {
    if (ctx.mounted) spawnSync('hdiutil', ['detach', ctx.mounted, '-force', '-quiet']);
    if (stage) fs.rmSync(stage, { recursive: true, force: true });
    if (work && (opts.keepTemp || (error && verbose))) console.log(`  temp kept: ${work}`);
    else if (work) fs.rmSync(work, { recursive: true, force: true });
  }
  // Signal handlers only run once the event loop turns, so report after that.
  setImmediate(() => {
    if (!error) process.exit(0);
    if (cancelled) error.code = 'CANCELLED';
    console.error(`\nERROR [${error.code}] ${error.message}`);
    if (error.detail) console.error(error.detail.split('\n').map((l) => `  ${l}`).join('\n'));
    process.exit(EXIT[error.code] ?? 1);
  });
}

main();
