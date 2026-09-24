// Phase 5.1: verification false positives found by the third-party review, and the matching
// "must still pass" cases. Faults are injected on the production path (a frame-rate policy, or an
// ffmpeg wrapper for the final encode); nothing in the core is aware of them.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { ConversionError } from '../../src/errors.ts';
import { writeDvdIso } from '../../src/iso/writer.ts';
import { convert, type ConversionResult } from '../../src/job.ts';
import { defaultPlatform } from '../../src/platform.ts';
import { FILTER_INTERLACE_60I, INTERLACED_POLICY, type FrameRatePolicy } from '../../src/profile/frame-rate.ts';
import { verifyOutput } from '../../src/verify/index.ts';
import { writeZip } from '../../src/zip.ts';
import { AUDIO_DELAY, SECOND_AUDIO, faultToolchain } from '../helpers/fault.ts';
import { makeSample, skipNoTools, tempDir, toolchain } from '../helpers/env.ts';

const work = tempDir();
const out = path.join(work, 'out');
const base = () => ({ toolchain: toolchain!, outputDirectory: out, lock: { dir: path.join(work, 'lock') }, tempRoot: path.join(work, 'jobs'), now: new Date('2026-09-24T00:00:00Z') });
const check = (r: ConversionResult, id: string) => r.verification.checks.find((c) => c.id === id);
after(() => fs.rmSync(work, { recursive: true, force: true }));

const verifyError = (pattern: RegExp) => (e: ConversionError) => {
  assert.equal(e.code, 'VERIFY_ERROR', `${e.code} ${e.message}`);
  assert.match(e.reason ?? '', pattern);
  return true;
};

describe('FI-60I-TEMPORAL-LOSS: 59.94i must carry ~59.94 distinct field moments per second', { skip: skipNoTools }, () => {
  // The review's fault: 60p decimated to 29.97p while the plan still says interlace-60i. Every picture
  // that remains is shown at the right time, so timing checks alone pass.
  const temporalLoss: FrameRatePolicy = {
    name: 'fi-60i-temporal-loss',
    decide: (c) => ({ ...INTERLACED_POLICY.decide(c), filter: 'fps=30000/1001:start_time=0' }),
  };

  test('60p decimated to 29.97p but labelled interlace-60i -> VERIFY_ERROR', async () => {
    const src = makeSample(path.join(work, 'fi-60i.mp4'), { rate: '60000/1001', motion: true, seconds: 5, size: '960x540' });
    await assert.rejects(convert({ ...base(), input: src, frameRatePolicy: temporalLoss }), verifyError(/video\.field_temporal/));
  });

  test('the same fault on colourful content with small moving parts (testsrc2, 59.94 fps) -> VERIFY_ERROR', async () => {
    const src = makeSample(path.join(work, 'fi-60i-testsrc.mp4'), { rate: '60000/1001', seconds: 5, size: '1280x720' });
    await assert.rejects(convert({ ...base(), input: src, frameRatePolicy: temporalLoss }), (e: ConversionError) => {
      verifyError(/video\.field_temporal/)(e);
      assert.match(e.detail ?? '', /coverage 0\.[45]\d*/);
      return true;
    });
  });

  test('FI-60I-FIELD-ORDER: fields swapped (later moment shown first) -> VERIFY_ERROR', async () => {
    const swapped: FrameRatePolicy = { name: 'fi-60i-field-order', decide: (c) => ({ ...INTERLACED_POLICY.decide(c), filter: `${FILTER_INTERLACE_60I},il=ls=1:cs=1` }) };
    const src = makeSample(path.join(work, 'fi-order.mp4'), { rate: '60000/1001', motion: true, seconds: 5, size: '960x540' });
    await assert.rejects(convert({ ...base(), input: src, frameRatePolicy: swapped }), (e: ConversionError) => {
      verifyError(/video\.field_temporal/)(e);
      assert.match(e.detail ?? '', /\d+\/\d+ field steps backwards/);
      return true;
    });
  });

  test('correct 59.94i from 59.94p passes with the field check measured', async () => {
    const r = await convert({ ...base(), input: makeSample(path.join(work, 'ok-60i.mp4'), { rate: '60000/1001', motion: true, seconds: 5, size: '960x540' }) });
    assert.equal(r.verification.passed, true, r.verification.failed.join(','));
    assert.equal(check(r, 'video.field_temporal')?.status, 'passed', check(r, 'video.field_temporal')?.detail);
    assert.ok((r.verification.fieldTemporal.coverage ?? 0) >= 0.95, JSON.stringify(r.verification.fieldTemporal));
  });

  test('a still picture labelled interlace-60i is unmeasurable, not a failure (nothing to lose)', async () => {
    const src = makeSample(path.join(work, 'still-60.mp4'), { rate: '60', still: true, seconds: 4 });
    for (const policy of [undefined, temporalLoss]) {
      const r = await convert({ ...base(), input: src, ...(policy ? { frameRatePolicy: policy } : {}) });
      assert.equal(r.plan.video.frameRate.strategy, 'interlace-60i');
      assert.equal(r.verification.passed, true, r.verification.failed.join(','));
      assert.equal(check(r, 'video.field_temporal')?.status, 'unmeasurable');
      assert.equal(r.verification.fieldTemporal.status, 'unmeasurable');
    }
  });
});

describe('FI-AUDIO-DELAY-STATIC: audio timing is judged even when the picture cannot be', { skip: skipNoTools }, () => {
  const timings = (r: ConversionResult) => ({
    video: r.verification.videoTiming.status, audio: r.verification.audioTiming.status, av: r.verification.relativeAvTiming.status,
  });

  test('still picture + clicks, correct timing -> PASS, sound timing measured', async () => {
    const r = await convert({ ...base(), input: makeSample(path.join(work, 'still-clicks.mp4'), { still: true, audio: 'clicks', seconds: 6 }) });
    assert.equal(r.verification.passed, true, r.verification.failed.join(','));
    assert.deepEqual(timings(r), { video: 'unmeasurable', audio: 'passed', av: 'unmeasurable' });
    assert.ok(Math.abs(r.verification.audioTiming.errorMs ?? 99) <= 1, String(r.verification.audioTiming.errorMs));
  });

  test('still picture + clicks, audio content delayed 100 ms -> VERIFY_ERROR', async () => {
    const src = makeSample(path.join(work, 'fi-delay.mp4'), { still: true, audio: 'clicks', seconds: 6 });
    const tc = faultToolchain(toolchain!, path.join(work, 'fault-delay'), AUDIO_DELAY(100));
    await assert.rejects(convert({ ...base(), toolchain: tc, input: src }), (e: ConversionError) => {
      verifyError(/sync\.audio_timing/)(e);
      assert.match(e.detail ?? '', /audio 1\d\d(\.\d)? ms late/);
      return true;
    });
  });

  test('still picture + distinctive noise, audio content delayed 100 ms -> VERIFY_ERROR', async () => {
    const src = makeSample(path.join(work, 'fi-delay-noise.mp4'), { still: true, audio: 'noise', seconds: 6 });
    const tc = faultToolchain(toolchain!, path.join(work, 'fault-delay-noise'), AUDIO_DELAY(100));
    await assert.rejects(convert({ ...base(), toolchain: tc, input: src }), verifyError(/sync\.audio_timing/));
  });

  test('still picture + digital silence -> PASS, sound timing unmeasurable', async () => {
    const r = await convert({ ...base(), input: makeSample(path.join(work, 'still-silent.mp4'), { still: true, audio: 'silent', seconds: 6 }) });
    assert.equal(r.verification.passed, true, r.verification.failed.join(','));
    assert.deepEqual(timings(r), { video: 'unmeasurable', audio: 'unmeasurable', av: 'unmeasurable' });
    assert.equal(check(r, 'sync.audio_timing')?.status, 'unmeasurable');
  });

  test('still picture + periodic sound (0.2 s pulses, steady tone) -> no offset is claimed, PASS', async () => {
    for (const audio of ['pulses', 'tone'] as const) {
      const r = await convert({ ...base(), input: makeSample(path.join(work, `still-${audio}.mp4`), { still: true, audio, seconds: 6 }) });
      assert.equal(r.verification.passed, true, `${audio}: ${r.verification.failed.join(',')}`);
      assert.equal(r.verification.audioTiming.status, 'unmeasurable', `${audio}: ${JSON.stringify(r.verification.audioTiming)}`);
    }
  });

  test('periodic sound delayed by half its period is ambiguous: unmeasurable, never a wrong offset', async () => {
    const src = makeSample(path.join(work, 'still-pulses-late.mp4'), { still: true, audio: 'pulses', seconds: 6 });
    const tc = faultToolchain(toolchain!, path.join(work, 'fault-pulses'), AUDIO_DELAY(100));
    const r = await convert({ ...base(), toolchain: tc, input: src });
    assert.equal(r.verification.audioTiming.status, 'unmeasurable', JSON.stringify(r.verification.audioTiming));
  });

  test('no source audio: sound timing is not applicable (silent track added)', async () => {
    const r = await convert({ ...base(), input: makeSample(path.join(work, 'still-noaudio.mp4'), { still: true, audio: 'none', seconds: 4 }) });
    assert.equal(r.verification.passed, true, r.verification.failed.join(','));
    assert.deepEqual(timings(r), { video: 'unmeasurable', audio: 'not_applicable', av: 'not_applicable' });
  });

  test('moving picture + clicks delayed 100 ms -> sound timing and picture-vs-sound both fail', async () => {
    const src = makeSample(path.join(work, 'moving-delay.mp4'), { rate: '60000/1001', motion: true, seconds: 5, size: '960x540' });
    const tc = faultToolchain(toolchain!, path.join(work, 'fault-moving'), AUDIO_DELAY(100));
    await assert.rejects(convert({ ...base(), toolchain: tc, input: src }), (e: ConversionError) => {
      verifyError(/sync\.audio_timing/)(e);
      assert.match(e.reason ?? '', /sync\.av_offset/);
      assert.doesNotMatch(e.reason ?? '', /sync\.video_timeline|video\.field_temporal/);
      return true;
    });
  });
});

describe('M1: short inputs are judged from the MPEG-2 stream, not ffprobe\'s frame-rate guess', { skip: skipNoTools }, () => {
  const cases = [
    { name: '1 frame', frames: 1 }, { name: '2 frames', frames: 2 }, { name: '3 frames', frames: 3 },
    { name: '0.5 s', seconds: 0.5 }, { name: '1 s', seconds: 1 },
    { name: '1 frame, no audio', frames: 1, audio: 'none' as const },
    { name: '1 frame at 23.976', frames: 1, rate: '24000/1001' }, { name: '1 frame at 25', frames: 1, rate: '25' },
    { name: '2 frames at 59.94', frames: 2, rate: '60000/1001' },
  ];
  for (const c of cases) {
    test(`${c.name} -> PASS`, async () => {
      const { name, ...sample } = c;
      const r = await convert({ ...base(), input: makeSample(path.join(work, `short-${name.replace(/\W+/g, '-')}.mp4`), sample) });
      assert.equal(r.verification.passed, true, `${r.verification.failed.join(',')} ${check(r, 'streams.video')?.detail}`);
      assert.equal(check(r, 'mpeg2.frame_rate')?.status, 'passed');
      assert.match(check(r, 'mpeg2.frame_rate')?.detail ?? '', /frame_rate_code 4 /);
    });
  }

  test('a single 59.94 frame (shorter than one DVD frame) fails safely: no output is left', async () => {
    const dir = path.join(work, 'out-short-5994');
    const src = makeSample(path.join(work, 'short-1-5994.mp4'), { frames: 1, rate: '60000/1001' });
    await assert.rejects(convert({ ...base(), outputDirectory: dir, input: src }), (e: ConversionError) => e.code === 'AUTHOR_ERROR');
    assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], []);
  });

  test('a wrong frame_rate_code in the MPEG-2 sequence header still fails', async () => {
    const good = await convert({ ...base(), input: makeSample(path.join(work, 'short-mutate.mp4'), { frames: 2 }) });
    const dir = path.join(work, 'short-mutated');
    fs.cpSync(good.outputDir, dir, { recursive: true });
    const vob = path.join(dir, 'VIDEO_TS/VTS_01_1.VOB');
    const b = fs.readFileSync(vob);
    const at = b.indexOf(Buffer.from([0, 0, 1, 0xb3]));
    b[at + 7] = (b[at + 7]! & 0xf0) | 5; // 30 fps
    fs.writeFileSync(vob, b);
    const r = await verifyOutput({ plan: good.plan, dir, toolchain: toolchain! });
    assert.ok(r.failed.includes('mpeg2.frame_rate'), r.failed.join(','));
  });
});

describe('M2: audio streams are judged by the packets they carry', { skip: skipNoTools }, () => {
  /** Turn one padding packet into a PES for MPEG audio stream 0xc0 with no payload (ffprobe then lists an empty mp2 stream). */
  const addPhantomAudio = (vob: string) => {
    const b = fs.readFileSync(vob);
    for (let off = 0; off + 2048 <= b.length; off += 2048) {
      if (b.readUInt32BE(off) !== 0x1ba) continue;
      let p = off + 14 + (b[off + 13]! & 7);
      while (p + 6 <= off + 2048 && b.readUInt32BE(p) >>> 8 === 1) {
        const len = b.readUInt16BE(p + 4);
        if (b[p + 3] === 0xbe && len >= 20) {
          b[p + 3] = 0xc0;
          b.writeUInt16BE(3, p + 4);
          b.set([0x80, 0x00, 0x00], p + 6);
          b.writeUInt32BE(0x1be, p + 9);
          b.writeUInt16BE(len - 9, p + 13);
          b.fill(0xff, p + 15, p + 15 + len - 9);
          fs.writeFileSync(vob, b);
          return;
        }
        p += 6 + len;
      }
    }
    throw new Error('no padding packet');
  };

  test('AC-3 stereo plus an empty phantom stream -> PASS (the phantom is ignored and reported)', async () => {
    const good = await convert({ ...base(), input: makeSample(path.join(work, 'phantom.mp4'), { seconds: 3 }) });
    const dir = path.join(work, 'phantom-out');
    fs.cpSync(good.outputDir, dir, { recursive: true });
    addPhantomAudio(path.join(dir, 'VIDEO_TS/VTS_01_1.VOB'));
    // Rebuild the ZIP and ISO from the patched VIDEO_TS so only the stream list differs.
    fs.rmSync(path.join(dir, 'VIDEO_TS.zip'));
    fs.rmSync(path.join(dir, good.plan.output.isoFileName));
    const date = new Date('2026-09-24T00:00:00Z');
    await writeZip(path.join(dir, 'VIDEO_TS'), path.join(dir, 'VIDEO_TS.zip'), { date });
    await writeDvdIso(path.join(dir, 'VIDEO_TS'), path.join(dir, good.plan.output.isoFileName), { volumeLabel: good.plan.output.volumeLabel, date });
    const r = await verifyOutput({ plan: good.plan, dir, toolchain: toolchain!, platform: defaultPlatform() });
    assert.equal(r.passed, true, r.failed.join(','));
    const audio = r.checks.find((c) => c.id === 'streams.audio');
    assert.match(audio?.detail ?? '', /ignored \(no packets\): mp2 0x1c0/);
    assert.match(audio?.detail ?? '', /PES payload bd-0x80 \d+ B$|PES payload bd-0x80 \d+ B;/);
  });

  test('two real AC-3 streams -> VERIFY_ERROR', async () => {
    const tc = faultToolchain(toolchain!, path.join(work, 'fault-two-audio'), SECOND_AUDIO);
    await assert.rejects(convert({ ...base(), toolchain: tc, input: makeSample(path.join(work, 'two-audio.mp4'), { seconds: 3 }) }), verifyError(/streams\.audio/));
  });

  test('audio packets missing from the VOB -> streams.audio fails', async () => {
    // dvdauthor refuses a stream without audio (AUTHOR_ERROR), so remove the AC-3 packets afterwards:
    // every private stream 1 PES becomes padding of the same length.
    const good = await convert({ ...base(), input: makeSample(path.join(work, 'lost-audio.mp4'), { seconds: 3 }) });
    const dir = path.join(work, 'lost-audio-out');
    fs.cpSync(good.outputDir, dir, { recursive: true });
    const vob = path.join(dir, 'VIDEO_TS/VTS_01_1.VOB');
    const b = fs.readFileSync(vob);
    for (let off = 0; off + 2048 <= b.length; off += 2048) {
      let p = off + 14 + (b[off + 13]! & 7);
      while (p + 6 <= off + 2048 && b.readUInt32BE(p) >>> 8 === 1) {
        if (b[p + 3] === 0xbd) b[p + 3] = 0xbe;
        p += 6 + b.readUInt16BE(p + 4);
      }
    }
    fs.writeFileSync(vob, b);
    const r = await verifyOutput({ plan: good.plan, dir, toolchain: toolchain! });
    assert.ok(r.failed.includes('streams.audio'), r.failed.join(','));
    assert.match(r.checks.find((c) => c.id === 'streams.audio')?.detail ?? '', /no audio packets; PES payload none/);
  });
});
