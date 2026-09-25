// Output verification: the Phase 2 checks (docs/poc.md §6) plus A/V sync, VOB start timestamps,
// UDF descriptor integrity and sector-level ISO content. "Files were written" is not success.

import fs from 'node:fs';
import path from 'node:path';
import { DVD_PLUS_R_SL_BYTES } from '../capacity.ts';
import { ConversionError, throwIfAborted } from '../errors.ts';
import { readVideoTs, type VideoTsLayout } from '../dvd/layout.ts';
import { SECTOR } from '../dvd/ifo.ts';
import { scanVobs } from '../dvd/vob.ts';
import { fingerprint, sha256File, type SourceFingerprint } from '../fsutil.ts';
import { inspectIso } from '../iso/reader.ts';
import { safeChildPath } from '../naming.ts';
import type { LogSink } from '../log.ts';
import type { PlatformAdapter } from '../platform.ts';
import type { ConversionPlan } from '../plan.ts';
import { runTool } from '../process.ts';
import type { Toolchain } from '../toolchain.ts';
import { readZip } from '../zip.ts';
import { expectedDisplayTime } from '../profile/frame-rate.ts';
import { WIDE_SEARCH_SEC, isInterlacedSource, judgeDisplacement, judgeFields, measureFields, temporalCapacity, type FieldTemporalResult } from './fields.ts';
import { measureSync, syncWindows, type SyncMeasurement } from './sync.ts';

export const DURATION_TOLERANCE_S = 0.15;
/**
 * Largest acceptable picture timing error / introduced A/V offset, after the strategy's own timing
 * is removed. Correct outputs measured 0–0.6 ms across all strategies; the Phase 2 59.94 bug measured
 * 33.4 ms and the VFR start bug 16.7 ms (docs/core.md §7).
 */
export const SYNC_TOLERANCE_MS = 10;
/**
 * Largest acceptable sound timing error against the output's video start. Same evidence as above:
 * correct outputs measured 0–0.6 ms; the review's delayed-audio fault measured 100 ms.
 */
export const AUDIO_TIMING_TOLERANCE_MS = SYNC_TOLERANCE_MS;
/** First audio vs first video PTS in the VOB (AC-3 encoder delay puts audio ~5.3 ms first). */
export const START_PTS_TOLERANCE_S = 0.034;
const NTSC_FPS = 30000 / 1001;
const AC3_FRAME_S = 1536 / 48000;

/**
 * passed / failed: the check ran and judged the output. unmeasurable: it was attempted but this video
 * gives it nothing to measure (a still picture, silence, a periodic sound). not_applicable: there is
 * nothing to check (no source audio, no source fingerprint). Only 'failed' fails verification.
 */
export type CheckStatus = 'passed' | 'failed' | 'unmeasurable' | 'not_applicable';

export interface VerificationCheck {
  id: string;
  /** status !== 'failed'. */
  ok: boolean;
  status: CheckStatus;
  detail: string;
}

export interface VerificationReport {
  passed: boolean;
  checks: VerificationCheck[];
  failed: string[];
  durations: { expectedVideo: number; expectedAudio: number; video: number; audio: number; ifo: number };
  /** Raw content measurements behind the timing results. */
  sync: SyncMeasurement;
  /** Picture timing against the source (moving pictures needed). */
  videoTiming: { status: CheckStatus; errorMs: number | null; matches: number };
  /** Sound timing against the source, on the output's video timeline (distinctive sound needed). */
  audioTiming: { status: CheckStatus; errorMs: number | null; confidentWindows: number; windows: number };
  /** Picture minus sound (both needed). */
  relativeAvTiming: { status: CheckStatus; offsetMs: number | null };
  /** Distinct source moments reaching the fields, and their order. */
  fieldTemporal: FieldTemporalResult;
}

export interface VerifyInput {
  plan: ConversionPlan;
  /** Folder holding VIDEO_TS/, VIDEO_TS.zip and the ISO. */
  dir: string;
  toolchain: Toolchain;
  platform?: PlatformAdapter;
  /** Source fingerprint taken before conversion. */
  sourceBefore?: SourceFingerprint;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  log?: LogSink;
}

export async function verifyOutput(input: VerifyInput): Promise<VerificationReport> {
  const { plan, dir, toolchain, signal } = input;
  const checks: VerificationCheck[] = [];
  const check = (id: string, ok: boolean, detail = '') => {
    checks.push({ id, ok, status: ok ? 'passed' : 'failed', detail });
    input.log?.({ level: ok ? 'debug' : 'warn', event: 'verify.check', message: id, data: { ok, detail } });
  };
  const notJudged = (id: string, status: 'unmeasurable' | 'not_applicable', detail: string) => {
    checks.push({ id, ok: true, status, detail });
    input.log?.({ level: 'info', event: 'verify.check', message: id, data: { status, detail } });
  };
  const progress = (f: number) => input.onProgress?.(f);
  const videoTsDir = path.join(dir, 'VIDEO_TS');
  const isoPath = safeChildPath(dir, plan.output.isoFileName);
  const zipPath = path.join(dir, 'VIDEO_TS.zip');

  // --- VIDEO_TS structure + IFO ------------------------------------------------------
  let layout: VideoTsLayout | null = null;
  try {
    layout = readVideoTs(videoTsDir);
    check('videots.files', true, layout.files.map((f) => f.name).join(' '));
  } catch (error) {
    check('videots.files', false, (error as Error).message);
  }
  const names = fs.existsSync(videoTsDir) ? fs.readdirSync(videoTsDir).sort() : [];
  check('videots.no_extra', names.every((n) => /^(VIDEO_TS\.(IFO|BUP)|VTS_01_0\.(IFO|BUP)|VTS_01_[1-9]\.VOB)$/.test(n)), names.join(' '));
  const vobs = names.filter((n) => /^VTS_01_[1-9]\.VOB$/.test(n)).map((n) => path.join(videoTsDir, n));
  const sizes = Object.fromEntries(names.map((n) => [n, fs.statSync(path.join(videoTsDir, n)).size]));
  check('videots.sectors', names.every((n) => (sizes[n] ?? 1) % SECTOR === 0) && vobs.every((v) => {
    const s = sizes[path.basename(v)] ?? 0;
    return s > 0 && s <= 1024 ** 3;
  }), '');
  const same = (a: string, b: string) => fs.existsSync(path.join(videoTsDir, a)) && fs.existsSync(path.join(videoTsDir, b)) &&
    fs.readFileSync(path.join(videoTsDir, a)).equals(fs.readFileSync(path.join(videoTsDir, b)));
  check('videots.bup_equals_ifo', same('VIDEO_TS.IFO', 'VIDEO_TS.BUP') && same('VTS_01_0.IFO', 'VTS_01_0.BUP'));

  const vmg = layout?.vmg;
  const vts = layout?.vts;
  check('ifo.vmg_id', vmg?.id === 'DVDVIDEO-VMG', vmg?.id ?? '');
  check('ifo.vts_id', vts?.id === 'DVDVIDEO-VTS', vts?.id ?? '');
  check('ifo.single_title', vmg?.titleSets === 1 && vmg.titles.length === 1 && vmg.titles[0]?.vts === 1, `${vmg?.titleSets}/${vmg?.titles.length}`);
  check('ifo.region_free', vmg?.regionMask === 0, `0x${(vmg?.regionMask ?? 255).toString(16)}`);
  check('ifo.autoplay', vmg?.firstPlay?.pre.includes('JumpTT 1') ?? false, JSON.stringify(vmg?.firstPlay?.pre ?? []));
  check('ifo.end_stop', vts?.pgcs[0]?.post.includes('Exit') ?? false, JSON.stringify(vts?.pgcs[0]?.post ?? []));
  check('ifo.video_attributes', vts?.video.mpeg === 'MPEG-2' && vts.video.standard === 'NTSC' && vts.video.aspect === '16:9' && vts.video.resolution === '720x480',
    vts ? Object.values(vts.video).join(' / ') : '');
  check('ifo.audio_attributes', vts?.audio.length === 1 && vts.audio[0]?.coding === 'ac3' && vts.audio[0].channels === 2 && vts.audio[0].sampleRate === 48000,
    JSON.stringify(vts?.audio ?? []));
  const vtsSectors = ((sizes['VTS_01_0.IFO'] ?? 0) + (sizes['VTS_01_0.BUP'] ?? 0) + vobs.reduce((s, v) => s + (sizes[path.basename(v)] ?? 0), 0)) / SECTOR;
  check('ifo.vts_last_sector', vts ? vts.lastSector + 1 === vtsSectors : false, `${(vts?.lastSector ?? 0) + 1} vs ${vtsSectors}`);
  check('ifo.title_vobs_start', vts ? vts.titleVobStart === (sizes['VTS_01_0.IFO'] ?? 0) / SECTOR : false, String(vts?.titleVobStart));
  progress(0.05);

  // --- VOB bitstream ---------------------------------------------------------------------
  const scan = scanVobs(vobs, signal);
  check('vob.packs', scan.badPacks === 0 && scan.packs > 0, `${scan.packs} packs, ${scan.badPacks} bad`);
  check('vob.nav_packs', scan.navPacks > 0, String(scan.navPacks));
  const seq = scan.sequence;
  check('mpeg2.sequence_header', seq?.width === 720 && seq.height === 480 && seq.aspectCode === 3 && seq.vbvKbit <= 1792 && scan.sequenceMismatches === 0,
    `${JSON.stringify(seq)}; ${scan.sequenceHeaders} headers, ${scan.sequenceMismatches} differ`);
  const counts = (m: Record<string, number>) => Object.entries(m).map(([k, n]) => `${k} x${n}`).join(', ') || 'none';
  check('mpeg2.progressive_sequence', JSON.stringify(Object.keys(scan.progressiveSequences)) === '["0"]', `progressive_sequence ${counts(scan.progressiveSequences)}`);
  check('mpeg2.gop', scan.maxGop > 0 && scan.maxGop <= 18, `max ${scan.maxGop}`);
  check('vob.audio_pts_monotonic', scan.audioPts > 0 && scan.audioPtsNonMonotonic === 0, `${scan.audioPts} PTS`);
  const startDelta = scan.firstVideoPts !== null && scan.firstAudioPts !== null ? scan.firstVideoPts - scan.firstAudioPts : null;
  check('vob.av_start', startDelta !== null && Math.abs(startDelta) <= START_PTS_TOLERANCE_S, startDelta === null ? 'missing' : `video - audio = ${(startDelta * 1000).toFixed(1)} ms`);
  progress(0.15);

  // --- full decode (ffprobe -count_frames; no muxer, so no false dts errors) -------------------
  const concat = `concat:${vobs.join('|')}`;
  // Streams are judged by what they carry. ffprobe can list a stream that has no packets (a PES header
  // without payload), and guesses r_frame_rate from the first few timestamps (60000/1001 for one or two
  // pictures); neither describes the MPEG-2 stream, so the frame rate comes from the sequence headers.
  let videoFrames = 0;
  let audioFrames = 0;
  let outOrigin = 0;
  let outVideoStart = 0;
  try {
    const r = await runTool(toolchain.ffprobe, [
      '-v', 'error', '-err_detect', 'crccheck', '-count_frames', '-count_packets',
      '-show_entries', 'format=start_time:stream=codec_type,codec_name,id,width,height,sample_aspect_ratio,display_aspect_ratio,r_frame_rate,sample_rate,channels,nb_read_frames,nb_read_packets,start_time',
      '-of', 'json', concat,
    ], { errorCode: 'VERIFY_ERROR', signal });
    const probe = JSON.parse(r.stdout) as { format?: { start_time?: string }; streams?: Record<string, string | number>[] };
    const streams = probe.streams ?? [];
    const { real: v } = carrying(streams, 'video');
    const { real: a } = carrying(streams, 'audio');
    check('decode.full', r.stderr.trim() === '', r.stderr.trim().split('\n').slice(0, 3).join(' | '));
    check('streams.video', v.length === 1 && v[0]?.codec_name === 'mpeg2video' && v[0].width === 720 && v[0].height === 480 &&
      v[0].sample_aspect_ratio === '32:27' && v[0].display_aspect_ratio === '16:9', v.map(describe).join('; '));
    const audio = judgeAudioStreams(streams, scan.audioPayload);
    check('streams.audio', audio.ok, audio.detail);
    videoFrames = Number(v[0]?.nb_read_frames ?? 0);
    // Every sequence header and every sequence extension (the frame rate can change at any of them).
    const extensions = Object.values(scan.frameRateExtensions).reduce((a, n) => a + n, 0);
    check('mpeg2.frame_rate', seq?.frameRateCode === 4 && scan.sequenceMismatches === 0 &&
      JSON.stringify(Object.keys(scan.frameRateExtensions)) === '["0/0"]' && extensions === scan.sequenceHeaders &&
      scan.pictures > 0 && scan.pictures === videoFrames,
      `frame_rate_code ${seq?.frameRateCode ?? '-'} (4 = 30000/1001) in ${scan.sequenceHeaders} sequence headers (${scan.sequenceMismatches} differ), ` +
      `frame_rate_extension ${counts(scan.frameRateExtensions)} in ${extensions} sequence extensions; ` +
      `${scan.pictures} coded pictures, ${videoFrames} decoded; ffprobe estimate ${v[0]?.r_frame_rate ?? '-'}`);
    audioFrames = Number(a[0]?.nb_read_frames ?? 0);
    outOrigin = Number(probe.format?.start_time ?? 0);
    outVideoStart = Number(v[0]?.start_time ?? outOrigin) - outOrigin;
  } catch (error) {
    if ((error as ConversionError).code === 'CANCELLED') throw error;
    check('decode.full', false, (error as ConversionError).detail ?? (error as Error).message);
    check('mpeg2.frame_rate', false, 'streams could not be decoded');
  }
  progress(0.35);

  // --- durations ------------------------------------------------------------------------
  const expectedVideo = plan.input.videoEnd;
  const expectedAudio = plan.audio?.strategy === 'silence' ? plan.input.videoEnd : (plan.input.audioEnd ?? plan.input.videoEnd);
  const videoDur = videoFrames / NTSC_FPS;
  const audioDur = audioFrames * AC3_FRAME_S;
  const ifoDur = vts?.pgcs[0]?.seconds ?? 0;
  const fmt = (x: number, e: number) => `${x.toFixed(3)} s vs ${e.toFixed(3)} s (Δ ${(x - e).toFixed(3)})`;
  check('duration.video', Math.abs(videoDur - expectedVideo) <= DURATION_TOLERANCE_S, fmt(videoDur, expectedVideo));
  check('duration.audio', Math.abs(audioDur - expectedAudio) <= DURATION_TOLERANCE_S + AC3_FRAME_S, fmt(audioDur, expectedAudio));
  check('duration.ifo', Math.abs(ifoDur - expectedVideo) <= DURATION_TOLERANCE_S, fmt(ifoDur, expectedVideo));

  // --- timing and field content, by content ----------------------------------------------------
  throwIfAborted(signal);
  const strategy = plan.video.frameRate.strategy;
  const hasSourceAudio = plan.audio?.strategy !== 'silence' && plan.audio?.sourceIndex != null;
  const interlaced = await isInterlacedSource(toolchain, plan.input.path, plan.video.sourceIndex, signal).catch((error: unknown) => {
    if ((error as ConversionError).code === 'CANCELLED') throw error;
    return false;
  });
  const capacityHz = temporalCapacity(strategy, interlaced);
  const pictures = await measureFields({
    toolchain,
    source: { path: plan.input.path, origin: plan.input.origin, videoIndex: plan.video.sourceIndex, duration: plan.input.videoEnd, colorMatrix: plan.video.inputColorMatrix, interlaced },
    output: { input: concat, origin: outOrigin, active: plan.video.active },
    windows: syncWindows(plan.input.videoEnd),
    capacityHz,
    signal,
  });
  throwIfAborted(signal);
  const sync = await measureSync({
    toolchain,
    source: {
      path: plan.input.path,
      origin: plan.input.origin,
      audioIndex: hasSourceAudio ? (plan.audio?.sourceIndex ?? null) : null,
      duration: plan.input.videoEnd,
    },
    output: { input: concat, origin: outOrigin, videoStart: outVideoStart },
    changes: pictures.changes,
    ambiguous: pictures.ambiguous,
    expectedDisplayTime: (t) => expectedDisplayTime(strategy, t, interlaced),
    signal,
  });
  const judge = (value: number | null, tolerance: number): CheckStatus => (value === null ? 'unmeasurable' : Math.abs(value) <= tolerance ? 'passed' : 'failed');

  // Pictures found only outside the search are shown at the wrong time, whatever the change points say.
  const displaced = judgeDisplacement(pictures.windows, pictures.displaced);
  // Repeating pictures (M-2) can only show that no repeat is on time; one that fits proves nothing.
  const offRepeats = sync.videoTimelineErrorMs === null && sync.videoAmbiguousMs !== null && sync.videoAmbiguousMs > SYNC_TOLERANCE_MS;
  const videoTiming = displaced
    ? { status: 'failed' as CheckStatus, errorMs: displaced.offsetMs, matches: sync.videoMatches }
    : offRepeats
      ? { status: 'failed' as CheckStatus, errorMs: sync.videoAmbiguousMs, matches: sync.videoMatches }
      : { status: judge(sync.videoTimelineErrorMs, SYNC_TOLERANCE_MS), errorMs: sync.videoTimelineErrorMs, matches: sync.videoMatches };
  const audioTiming = {
    status: hasSourceAudio ? judge(sync.audioTimingErrorMs, AUDIO_TIMING_TOLERANCE_MS) : 'not_applicable' as CheckStatus,
    errorMs: sync.audioTimingErrorMs,
    confidentWindows: sync.audioMatches,
    windows: sync.windows.length,
  };
  const relativeAvTiming = {
    status: hasSourceAudio ? judge(sync.introducedOffsetMs, SYNC_TOLERANCE_MS) : 'not_applicable' as CheckStatus,
    offsetMs: sync.introducedOffsetMs,
  };
  const fieldTemporal = judgeFields(pictures.stats, capacityHz, pictures.windows);
  const record = (id: string, status: CheckStatus, detail: string) => {
    if (status === 'passed' || status === 'failed') check(id, status === 'passed', detail);
    else notJudged(id, status, detail);
  };
  const late = (x: number | null) => (x === null ? '-' : `${x >= 0 ? '+' : ''}${x} ms`);

  record('sync.video_timeline', videoTiming.status, displaced
    ? `picture about ${late(Math.round(displaced.offsetMs))}: ${displaced.fields} of ${displaced.of} fields show source pictures found only more than 250 ms away (searched ±${WIDE_SEARCH_SEC * 1000} ms)`
    : offRepeats
    ? `picture off by at least ${sync.videoAmbiguousMs} ms: the pictures repeat within ±250 ms and none of the repeats is on time (${sync.videoAmbiguousMatches} changes)`
    : videoTiming.errorMs !== null
    ? `picture ${late(videoTiming.errorMs)} (${sync.videoMatches} picture changes)`
    : sync.videoAmbiguousMatches > 0
    ? `not measurable: ${sync.videoMatches} clear picture changes; ${sync.videoAmbiguousMatches} into pictures that repeat within ±250 ms, whose time cannot be told from the picture`
    : `not measurable: ${sync.videoMatches} clear picture changes (still, slow or repeated pictures)`);
  record('sync.audio_timing', audioTiming.status, !hasSourceAudio ? 'no source audio (silent track added)'
    : audioTiming.errorMs !== null
      ? `audio ${audioTiming.errorMs >= 0 ? `${audioTiming.errorMs} ms late` : `${-audioTiming.errorMs} ms early`} against the video start (windows ${sync.audioWindowOffsetsMs.join(', ')} ms; ${sync.audioMatches}/${sync.windows.length} confident)`
      : `not measurable: ${sync.audioMatches}/${sync.windows.length} windows with a unique match (silent, steady or periodic sound)`);
  record('sync.av_offset', relativeAvTiming.status, !hasSourceAudio ? 'no source audio (silent track added)'
    : relativeAvTiming.offsetMs !== null
      ? `introduced ${relativeAvTiming.offsetMs} ms (video ${sync.videoOffsetMs}, audio ${sync.audioOffsetMs}; ${sync.videoMatches}/${sync.audioMatches} matches)`
      : `not measurable: needs both picture (${videoTiming.status}) and sound (${audioTiming.status}) timing`);
  record('video.field_temporal', fieldTemporal.status, `${strategy}: ${fieldTemporal.reason}`);
  progress(0.5);

  // --- ZIP -----------------------------------------------------------------------------------
  const hashes = new Map<string, string>();
  for (const n of names) hashes.set(n, await sha256File(path.join(videoTsDir, n), signal));
  try {
    const entries = await readZip(zipPath, { signal });
    check('zip.structure', true, `${entries.length} entries`);
    const expected = ['VIDEO_TS/', ...names.map((n) => `VIDEO_TS/${n}`)].sort();
    check('zip.entries', JSON.stringify(entries.map((e) => e.name).sort()) === JSON.stringify(expected), entries.map((e) => e.name).join(' '));
    check('zip.crc', entries.every((e) => e.crcOk), entries.filter((e) => !e.crcOk).map((e) => e.name).join(' '));
    check('zip.content', entries.filter((e) => !e.name.endsWith('/')).every((e) => hashes.get(e.name.slice('VIDEO_TS/'.length)) === e.sha256));
  } catch (error) {
    if ((error as ConversionError).code === 'CANCELLED') throw error;
    check('zip.structure', false, (error as Error).message);
  }
  progress(0.65);

  // --- ISO --------------------------------------------------------------------------------
  const capacity = judgeIsoCapacity(fs.existsSync(isoPath) ? fs.statSync(isoPath).size : null);
  check('iso.capacity', capacity.ok, capacity.detail);
  try {
    const iso = inspectIso(isoPath);
    check('iso.volume_id', iso.iso9660?.volumeId === plan.output.volumeLabel && iso.udf?.volumeId === plan.output.volumeLabel,
      `${iso.iso9660?.volumeId} / ${iso.udf?.volumeId}`);
    check('iso.bridge', Boolean(iso.iso9660) && ['CD001', 'BEA01', 'NSR02', 'TEA01'].every((id) => iso.udf?.vrs.includes(id)) && (iso.udf?.anchors.length ?? 0) >= 2,
      `${iso.udf?.vrs.join(' ')}; anchors ${iso.udf?.anchors.join(',')}`);
    check('iso.udf_102', iso.udf?.revision === 0x0102 && iso.udf.domain === '*OSTA UDF Compliant', `rev 0x${iso.udf?.revision.toString(16)}`);
    check('iso.structure', iso.issues.length === 0, iso.issues.slice(0, 5).join('; '));
    const ifoSector = iso.files.find((f) => f.path === 'VIDEO_TS/VIDEO_TS.IFO')?.isoSector ?? null;
    const order = layout?.files.map((f) => iso.files.find((x) => x.path === `VIDEO_TS/${f.name}`)?.isoSector ?? -1) ?? [];
    check('iso.file_order', order.length > 0 && order.every((s, i) => s >= 0 && (i === 0 || s > (order[i - 1] ?? 0))), order.join(' '));
    check('iso.ifo_addresses', ifoSector !== null && (layout?.files.every((f) => iso.files.find((x) => x.path === `VIDEO_TS/${f.name}`)?.isoSector === ifoSector + f.offset) ?? false),
      `VMG at ${ifoSector}`);
    let contentOk = iso.files.length === names.length;
    for (const f of iso.files) {
      const name = f.path.replace(/^VIDEO_TS\//, '');
      const h = f.isoSector === null ? '' : await sha256File(isoPath, signal, { start: f.isoSector * SECTOR, length: f.size });
      if (h !== hashes.get(name)) contentOk = false;
    }
    check('iso.content', contentOk, `${iso.files.length} files`);
  } catch (error) {
    if ((error as ConversionError).code === 'CANCELLED') throw error;
    check('iso.structure', false, (error as Error).message);
  }
  progress(0.85);

  const mount = input.platform?.mountImage;
  if (mount) {
    try {
      const m = await mount.call(input.platform, isoPath, signal);
      try {
        check('iso.mount', true, input.platform?.name ?? '');
        check('iso.mount_udf', m.fsType === 'udf', String(m.fsType));
        const mounted = path.join(m.mountPoint, 'VIDEO_TS');
        const list = fs.existsSync(mounted) ? fs.readdirSync(mounted).sort() : [];
        check('iso.mount_files', JSON.stringify(list) === JSON.stringify(names) && list.every((n) => fs.statSync(path.join(mounted, n)).size === sizes[n]), list.join(' '));
        const first = list.find((n) => n.endsWith('.VOB'));
        const p = first ? await runTool(toolchain.ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', path.join(mounted, first)], { errorCode: 'VERIFY_ERROR', signal }) : null;
        check('iso.mount_vob_readable', Boolean(p && /mpeg2video/.test(p.stdout) && /ac3/.test(p.stdout)), p?.stdout.trim().split('\n').join(' ') ?? '');
      } finally {
        await m.detach();
      }
    } catch (error) {
      if ((error as ConversionError).code === 'CANCELLED') throw error;
      check('iso.mount', false, (error as ConversionError).detail ?? (error as Error).message);
    }
  } else notJudged('iso.mount', 'unmeasurable', 'platform cannot mount images');

  // --- source ---------------------------------------------------------------------------
  if (input.sourceBefore) {
    const after = await fingerprint(plan.input.path, signal);
    const b = input.sourceBefore;
    check('source.unchanged', after.size === b.size && after.mtimeMs === b.mtimeMs && after.ino === b.ino && after.edgesSha256 === b.edgesSha256);
  } else notJudged('source.unchanged', 'not_applicable', 'no fingerprint');
  progress(1);

  const failed = checks.filter((c) => !c.ok).map((c) => c.id);
  return {
    passed: failed.length === 0,
    checks,
    failed,
    durations: { expectedVideo, expectedAudio, video: videoDur, audio: audioDur, ifo: ifoDur },
    sync,
    videoTiming,
    audioTiming,
    relativeAvTiming,
    fieldTemporal,
  };
}

/**
 * The ISO that was written must fit the smaller single-layer disc (DVD+R SL). Judged on the file's
 * bytes: the plan's estimate is what the bitrate was chosen from, not evidence of what came out.
 */
export function judgeIsoCapacity(bytes: number | null): { ok: boolean; detail: string } {
  if (bytes === null) return { ok: false, detail: 'no ISO' };
  const margin = DVD_PLUS_R_SL_BYTES - bytes;
  return {
    ok: margin >= 0,
    detail: `${bytes} of ${DVD_PLUS_R_SL_BYTES} bytes (DVD+R SL), ${margin >= 0 ? `${margin} bytes free` : `${-margin} bytes over`}`,
  };
}

type ProbeStream = Record<string, string | number>;

/** Streams of one type that carry packets, and those ffprobe lists without any. */
export function carrying(streams: ProbeStream[], type: 'video' | 'audio'): { real: ProbeStream[]; empty: ProbeStream[] } {
  const all = streams.filter((s) => s.codec_type === type);
  const packets = (s: ProbeStream) => Number(s.nb_read_packets ?? 0) || 0;
  return { real: all.filter((s) => packets(s) > 0), empty: all.filter((s) => packets(s) === 0) };
}

/**
 * DVD audio: exactly one stream that carries packets, AC-3 48 kHz stereo on substream 0x80, and the
 * VOB's own PES payload agrees (one audio stream with payload, the same one). Two sources, so a stream
 * ffprobe lists without data is ignored and one it misses is still counted.
 */
export function judgeAudioStreams(streams: ProbeStream[], payload: Record<string, number>): { ok: boolean; detail: string } {
  const { real, empty } = carrying(streams, 'audio');
  const withPayload = Object.entries(payload).filter(([, bytes]) => bytes > 0);
  const a = real[0];
  const ok = real.length === 1 && a?.codec_name === 'ac3' && a.id === '0x80' && a.sample_rate === '48000' && a.channels === 2 &&
    withPayload.length === 1 && withPayload[0]?.[0] === 'bd-0x80';
  const detail = `${real.map(describe).join('; ') || 'no audio packets'}; PES payload ${withPayload.map(([k, n]) => `${k} ${n} B`).join(', ') || 'none'}` +
    (empty.length ? `; ignored (no packets): ${empty.map(describe).join('; ')}` : '');
  return { ok, detail };
}

function describe(s: ProbeStream): string {
  return [s.codec_name, s.id, s.width ? `${s.width}x${s.height}` : null, s.sample_rate ? `${s.sample_rate} Hz` : null,
    s.channels !== undefined ? `${s.channels} ch` : null, `${s.nb_read_packets ?? 0} packets`].filter(Boolean).join(' ');
}
