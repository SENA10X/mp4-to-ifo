import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { classifyHdr, scanOf, type InputAnalysis, type VideoInfo } from '../../src/analyze.ts';
import { ConversionError, ERROR_CODES, exitCodeFor } from '../../src/errors.ts';
import { crc16, dstring, finishTag, tagChecksum } from '../../src/iso/encoding.ts';
import { finalize, nextOutputDirectory } from '../../src/job.ts';
import { createErrorReport, redact } from '../../src/log.ts';
import { planConversion } from '../../src/plan.ts';
import { findOnPath } from '../../src/toolchain.ts';
import { DURATION_TOLERANCE_S, SYNC_TOLERANCE_MS } from '../../src/verify/index.ts';
import { matchAudio } from '../../src/verify/sync.ts';
import { readZip, writeZip } from '../../src/zip.ts';

test('error codes map to CLI exit codes', () => {
  assert.deepEqual([...ERROR_CODES].sort(), ['AUTHOR_ERROR', 'CANCELLED', 'ENCODE_ERROR', 'INPUT_ERROR', 'INTERNAL_ERROR', 'ISO_ERROR', 'OUTPUT_ERROR', 'PREFLIGHT_ERROR', 'VERIFY_ERROR', 'ZIP_ERROR']);
  const code = (c: (typeof ERROR_CODES)[number]) => exitCodeFor(new ConversionError(c, 'x'));
  assert.equal(code('INPUT_ERROR'), 2);
  assert.equal(code('VERIFY_ERROR'), 3);
  assert.equal(code('CANCELLED'), 4);
  for (const c of ['PREFLIGHT_ERROR', 'ENCODE_ERROR', 'AUTHOR_ERROR', 'ZIP_ERROR', 'ISO_ERROR', 'OUTPUT_ERROR', 'INTERNAL_ERROR'] as const) assert.equal(code(c), 1);
  assert.equal(exitCodeFor(new Error('plain')), 1);
});

test('error reports redact paths, file names and the home directory', () => {
  const input = path.join(os.homedir(), 'Movies', '山田家 opening.mp4');
  const err = new ConversionError('ENCODE_ERROR', `ffmpeg failed on ${input}`, { detail: `Error opening ${input}\n${os.homedir()}/x\nopening in 山田家 opening.mp4` });
  const report = createErrorReport(err, { sensitive: [input, '/Volumes/SSD/out'] });
  const text = JSON.stringify(report);
  assert.ok(!text.includes('山田家'), text);
  assert.ok(!text.includes(os.homedir()), text);
  assert.equal(report.code, 'ENCODE_ERROR');
  assert.equal(redact('/Volumes/SSD/out/a', ['/Volumes/SSD/out']), '<path>/a');
});

test('duration and sync tolerances are the measured values', () => {
  assert.equal(DURATION_TOLERANCE_S, 0.15);
  assert.equal(SYNC_TOLERANCE_MS, 10);
});

test('CRC-16/CCITT and descriptor tags (ECMA-167 7.2)', () => {
  assert.equal(crc16(Buffer.from('123456789')), 0x31c3);
  const d = finishTag(Buffer.alloc(512), 2, 256);
  assert.equal(d.readUInt16LE(0), 2);
  assert.equal(d.readUInt32LE(12), 256);
  assert.equal(d.readUInt16LE(10), 496);
  assert.equal(tagChecksum(d), d[4]);
  const ds = dstring('ABC', 32);
  assert.deepEqual([ds[0], ds[1], ds[3], ds[31]], [8, 0x41, 0x43, 4]);
  assert.equal(dstring('', 32).every((b) => b === 0), true);
});

test('ZIP round trip, CRC detection and unzip compatibility', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'));
  const src = path.join(dir, 'VIDEO_TS');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'VIDEO_TS.IFO'), Buffer.alloc(6144, 1));
  fs.writeFileSync(path.join(src, 'VTS_01_1.VOB'), Buffer.from(Array.from({ length: 100_000 }, (_, i) => i & 255)));
  const zip = path.join(dir, 'VIDEO_TS.zip');
  await writeZip(src, zip, { date: new Date('2026-01-02T03:04:06Z') });
  const entries = await readZip(zip);
  assert.deepEqual(entries.map((e) => e.name), ['VIDEO_TS/', 'VIDEO_TS/VIDEO_TS.IFO', 'VIDEO_TS/VTS_01_1.VOB']);
  assert.ok(entries.every((e) => e.crcOk));
  assert.equal(entries[2]?.crc, zlib.crc32(fs.readFileSync(path.join(src, 'VTS_01_1.VOB'))) >>> 0);
  await assert.rejects(writeZip(src, zip, { date: new Date() }), /EEXIST/); // never overwrites
  // flip one data byte
  const buf = fs.readFileSync(zip);
  buf[200] = (buf[200] ?? 0) ^ 0xff;
  fs.writeFileSync(zip, buf);
  assert.ok((await readZip(zip)).some((e) => !e.crcOk));
  fs.rmSync(dir, { recursive: true });
});

test('finalize never overwrites: name, name-2, name-3', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-'));
  fs.mkdirSync(path.join(dir, 'opening'));
  fs.writeFileSync(path.join(dir, 'opening', 'keep.txt'), 'user data');
  fs.mkdirSync(path.join(dir, 'opening-2'));
  fs.writeFileSync(path.join(dir, 'opening-2', 'keep.txt'), 'user data');
  const staging = path.join(dir, '.mp4-to-ifo-x.partial');
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(staging, 'a'), 'new');
  const final = finalize(staging, dir, 'opening');
  assert.equal(path.basename(final), 'opening-3');
  assert.equal(fs.readFileSync(path.join(dir, 'opening', 'keep.txt'), 'utf8'), 'user data');
  assert.equal(fs.existsSync(staging), false);
  fs.rmSync(dir, { recursive: true });
});

function analysis(overrides: Partial<InputAnalysis> & { duration?: number } = {}): InputAnalysis {
  const duration = overrides.duration ?? 300;
  return {
    path: '/in/opening.mp4', fileSize: 1, modifiedMs: 1, container: 'mov,mp4', majorBrand: 'isom', duration, startTime: 0,
    video: {
      index: 0, codec: 'h264', profile: null, width: 1920, height: 1080, sampleAspectRatio: { num: 1, den: 1 }, displayAspectRatio: 16 / 9,
      frameRate: 30000 / 1001, rFrameRate: { num: 30000, den: 1001 }, avgFrameRate: { num: 30000, den: 1001 }, isVariableFrameRate: false,
      frameCount: null, pixelFormat: 'yuv420p', fieldOrder: 'progressive', scan: 'progressive', color: { space: 'bt709', transfer: 'bt709', primaries: 'bt709', range: 'tv' },
      rotation: 0, hdr: { kind: 'sdr', dolbyVision: null }, startTime: 0, duration,
    },
    audioTracks: [{ index: 1, codec: 'aac', sampleRate: 48000, channels: 2, channelLayout: 'stereo', default: true, startTime: 0, duration }],
    subtitleTracks: [],
    selectedAudio: 0,
    ...overrides,
  };
}

test('plan: warnings vs blocking errors', () => {
  const ok = planConversion(analysis());
  assert.deepEqual(ok.warnings, []);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.video.bitrateKbps, 8000);
  assert.equal(ok.output.directory, '/in');
  assert.equal(ok.output.isoFileName, 'opening.iso');
  assert.equal(JSON.parse(JSON.stringify(ok)).video.filter, ok.video.filter); // serializable

  const long = planConversion(analysis({ duration: 3 * 3600 }));
  assert.deepEqual(long.warnings.map((w) => w.code), ['LOW_BITRATE']);
  assert.deepEqual(planConversion(analysis({ duration: 9 * 3600 })).errors.map((e) => e.code), ['TOO_LONG']);

  const noAudio = planConversion(analysis({ audioTracks: [], selectedAudio: null }));
  assert.deepEqual(noAudio.warnings.map((w) => w.code), ['NO_AUDIO']);
  assert.equal(noAudio.audio?.strategy, 'silence');

  const subs = planConversion(analysis({ subtitleTracks: [{ index: 2, codec: 'mov_text', language: 'jpn' }] }));
  assert.deepEqual(subs.warnings.map((w) => w.code), ['SUBTITLES_NOT_INCLUDED']);

  const a = analysis();
  const quad = planConversion({ ...a, audioTracks: [{ ...a.audioTracks[0]!, channels: 4, channelLayout: 'quad' }] });
  assert.deepEqual(quad.errors.map((e) => e.code), ['UNSUPPORTED_AUDIO_LAYOUT']);

  const hdr = planConversion({ ...a, video: { ...a.video, hdr: { kind: 'hlg', dolbyVision: null } } });
  assert.deepEqual(hdr.warnings.map((w) => w.code), ['HDR_TONEMAP_EXPERIMENTAL']);
  assert.match(hdr.video.filter, /^zscale=/);
  assert.deepEqual(planConversion({ ...a, video: { ...a.video, hdr: { kind: 'hlg', dolbyVision: null } } }, { hdr: 'reject' }).errors.map((e) => e.code), ['HDR_DISABLED']);
  const dv5 = planConversion({ ...a, video: { ...a.video, hdr: { kind: 'dolby-vision', dolbyVision: { profile: 5, compatibilityId: 0, baseLayer: 'none' } } } });
  assert.deepEqual(dv5.errors.map((e) => e.code), ['UNSUPPORTED_HDR']);
  assert.deepEqual(dv5.warnings, [], 'Profile 5 is an error only, not also a "base layer" warning');

  const multi = planConversion({ ...a, audioTracks: [{ ...a.audioTracks[0]!, default: false }, { ...a.audioTracks[0]!, index: 2, default: true }], selectedAudio: 1 });
  assert.equal(multi.audio?.sourceIndex, 2);
  assert.deepEqual(multi.warnings.map((w) => w.code), ['MULTIPLE_AUDIO_TRACKS']);
});

test('sync matching: audio needs a unique peak (picture change points: verify.test.ts)', () => {
  const rate = 8000;
  const s = new Float32Array(rate * 2).map((_, i) => (i % 997 === 0 ? 1 : 0) + Math.sin(i * 0.01) * 0.01 + (((i * 7919) % 101) / 101 - 0.5) * 0.2);
  const o = s.slice(rate / 2 - 40, rate / 2 - 40 + rate); // output starts 0.5 s in, 40 samples early => +5 ms
  assert.equal(matchAudio(s, 0, o, 0.5), 0.005);
  const tone = new Float32Array(rate * 2).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / rate));
  assert.equal(matchAudio(tone, 0, tone.slice(rate / 2, rate / 2 + rate), 0.5), null);
});

test('Zip64 structures (forced on small data) read back and pass Info-ZIP unzip -t', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'));
  const src = path.join(dir, 'VIDEO_TS');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'VIDEO_TS.IFO'), Buffer.alloc(6144, 7));
  fs.writeFileSync(path.join(src, 'VTS_01_1.VOB'), Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 31) & 255)));
  const zip = path.join(dir, 'VIDEO_TS.zip');
  await writeZip(src, zip, { date: new Date('2026-01-02T03:04:06Z'), zip64: 'always' });
  const buf = fs.readFileSync(zip);
  assert.ok(buf.includes(Buffer.from([0x50, 0x4b, 0x06, 0x06])), 'Zip64 end of central directory record');
  assert.ok(buf.includes(Buffer.from([0x50, 0x4b, 0x06, 0x07])), 'Zip64 locator');
  const entries = await readZip(zip);
  assert.deepEqual(entries.map((e) => [e.name, e.size, e.crcOk]), [['VIDEO_TS/', 0, true], ['VIDEO_TS/VIDEO_TS.IFO', 6144, true], ['VIDEO_TS/VTS_01_1.VOB', 70_000, true]]);
  if (findOnPath('unzip')) {
    const r = spawnSync('unzip', ['-t', zip], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /No errors detected/);
  }
  fs.rmSync(dir, { recursive: true });
});

test('unknown transfer characteristics are not guessed (unsupported), known SDR transfers are SDR', () => {
  assert.equal(classifyHdr({ index: 0, color_transfer: 'smpte428' }).kind, 'unknown');
  assert.equal(classifyHdr({ index: 0, color_transfer: 'linear' }).kind, 'unknown');
  assert.equal(classifyHdr({ index: 0, color_transfer: 'iec61966-2-1' }).kind, 'sdr');
  assert.equal(classifyHdr({ index: 0 }).kind, 'sdr');
  assert.equal(planConversion({ ...analysis(), video: { ...analysis().video, hdr: { kind: 'unknown', dolbyVision: null } } }).errors[0]?.code, 'UNSUPPORTED_HDR');
});

test('nextOutputDirectory previews the numbered name without creating anything', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fin-'));
  assert.equal(nextOutputDirectory(dir, 'opening'), path.join(dir, 'opening'));
  fs.mkdirSync(path.join(dir, 'opening'));
  assert.equal(nextOutputDirectory(dir, 'opening'), path.join(dir, 'opening-2'));
  assert.deepEqual(fs.readdirSync(dir), ['opening']);
  fs.rmSync(dir, { recursive: true });
});

test('M-5: scan from the decoded frames, the stream label only as a fallback', () => {
  const f = (interlaced: boolean, topFirst: boolean) => ({ interlaced, topFirst });
  assert.equal(scanOf([f(false, false), f(false, false)], 'tt'), 'progressive', 'frames win over the label');
  assert.equal(scanOf([f(true, true), f(true, true), f(false, false)], 'progressive'), 'tff');
  assert.equal(scanOf([f(true, false), f(true, false)], 'tb'), 'bff');
  assert.equal(scanOf([], 'tt'), 'tff');
  assert.equal(scanOf([], 'bb'), 'bff');
  assert.equal(scanOf([], 'progressive'), 'progressive');
  // tb / bt mean opposite field orders in different demuxers.
  for (const label of ['tb', 'bt', 'unknown', null, undefined]) assert.equal(scanOf([], label), 'unknown');
});

test('M-5: interlaced input changes the picture filters only for interlaced input', () => {
  const plan = (scan: VideoInfo['scan'], frameRate = 30000 / 1001) => {
    const a = analysis();
    return planConversion({ ...a, video: { ...a.video, scan, frameRate, avgFrameRate: { num: Math.round(frameRate * 1001), den: 1001 } } }).video.filter;
  };
  const progressive = plan('progressive');
  assert.doesNotMatch(progressive, /interl|fieldorder|estdif/);
  assert.equal(plan('unknown'), progressive, 'unknown is treated as progressive, as before');
  // Whole frames passed through: each field scaled on its own; bottom-first moved to the top first.
  assert.match(plan('tff'), /^scale=[^,]*:interl=1,pad=/);
  assert.match(plan('bff'), /^fieldorder=tff,scale=[^,]*:interl=1,pad=/);
  // Strategies that build fields from moments: the fields become frames first.
  assert.match(plan('tff', 25), /^estdif=mode=field:parity=auto:deint=all,scale=[^,]*flags=lanczos,pad=/);
  assert.doesNotMatch(plan('bff', 25), /interl|fieldorder/);
});
