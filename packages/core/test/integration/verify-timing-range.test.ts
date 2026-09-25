// Beta Hardening: timing faults larger than the ±250 ms content search (M-3) and pictures that repeat
// within it (M-2). Faults keep every duration, so only content timing can see them; they are injected
// on the production path (a frame-rate policy, or an ffmpeg wrapper for the final encode).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { ConversionError } from '../../src/errors.ts';
import { convert, type ConversionResult } from '../../src/job.ts';
import { FILTER_INTERLACE_60I, INTERLACED_POLICY, type FrameRatePolicy } from '../../src/profile/frame-rate.ts';
import { AUDIO_SHIFT, faultToolchain } from '../helpers/fault.ts';
import { makeSample, skipNoTools, tempDir, toolchain, type SampleOptions } from '../helpers/env.ts';

const work = tempDir();
const out = path.join(work, 'out');
const base = () => ({ toolchain: toolchain!, outputDirectory: out, lock: { dir: path.join(work, 'lock') }, tempRoot: path.join(work, 'jobs'), now: new Date('2026-09-24T00:00:00Z') });
const check = (r: ConversionResult, id: string) => r.verification.checks.find((c) => c.id === id);
after(() => fs.rmSync(work, { recursive: true, force: true }));

const verifyError = (pattern: RegExp, detail?: RegExp) => (e: ConversionError) => {
  assert.equal(e.code, 'VERIFY_ERROR', `${e.code} ${e.message} ${e.detail ?? ''}`);
  assert.match(e.reason ?? '', pattern);
  if (detail) assert.match(e.detail ?? '', detail);
  return true;
};

/** The picture shifted by `s` seconds (positive = late) with its length kept: held at one end, trimmed at the other. */
const pictureShift = (s: number, seconds: number): FrameRatePolicy => ({
  name: `picture-shift-${s}`,
  decide: (c) => {
    const d = INTERLACED_POLICY.decide(c);
    const shift = s >= 0 ? `setpts=PTS+${s}/TB,trim=end=${seconds}` : `tpad=stop_mode=clone:stop_duration=${-s},trim=start=${-s},setpts=PTS-STARTPTS`;
    return { ...d, filter: `${shift},${d.filter}` };
  },
});

const SECONDS = 6;
const motion: SampleOptions = { rate: '60000/1001', motion: true, seconds: SECONDS, size: '960x540' };
const testsrc: SampleOptions = { rate: '30000/1001', seconds: SECONDS, size: '1280x720', audio: 'noise' };
const stillNoise: SampleOptions = { still: true, audio: 'noise', seconds: SECONDS };

describe('M-3: a picture or sound more than 250 ms off is a timing fault, not "unmeasurable"', { skip: skipNoTools }, () => {
  for (const [name, sample] of [['motion 59.94', motion], ['testsrc2 29.97 (static background)', testsrc]] as const) {
    for (const s of [0.4, -0.4]) {
      test(`${name}: picture ${s > 0 ? '+' : ''}${s * 1000} ms, durations kept -> VERIFY_ERROR`, async () => {
        const src = makeSample(path.join(work, `m3-${name.replace(/\W+/g, '-')}.mp4`), sample);
        await assert.rejects(convert({ ...base(), input: src, frameRatePolicy: pictureShift(s, SECONDS) }),
          // The offset of a displaced picture is reported coarsely (field to whole source frame).
          verifyError(/sync\.video_timeline/, new RegExp(`picture about ${s > 0 ? '\\+' : '-'}(3[5-9]\\d|4[0-4]\\d) ms`)));
      });
    }
  }

  for (const ms of [400, -400]) {
    test(`still picture + noise: sound ${ms > 0 ? '+' : ''}${ms} ms, durations kept -> VERIFY_ERROR`, async () => {
      const src = makeSample(path.join(work, 'm3-still-noise.mp4'), stillNoise);
      const tc = faultToolchain(toolchain!, path.join(work, `fault-m3-audio${ms}`), AUDIO_SHIFT(ms, SECONDS));
      await assert.rejects(convert({ ...base(), toolchain: tc, input: src }),
        verifyError(/sync\.audio_timing/, ms > 0 ? /audio (39\d|40\d)(\.\d)? ms late/ : /audio (39\d|40\d)(\.\d)? ms early/));
    });
  }

  test('moving picture + noise: sound +400 ms -> sound timing and picture-vs-sound fail', async () => {
    const src = makeSample(path.join(work, 'm3-motion-noise.mp4'), { ...motion, audio: 'noise' });
    const tc = faultToolchain(toolchain!, path.join(work, 'fault-m3-motion'), AUDIO_SHIFT(400, SECONDS));
    await assert.rejects(convert({ ...base(), toolchain: tc, input: src }), (e: ConversionError) => {
      verifyError(/sync\.audio_timing/)(e);
      assert.match(e.reason ?? '', /sync\.av_offset/);
      assert.doesNotMatch(e.reason ?? '', /sync\.video_timeline|video\.field_temporal|duration/);
      return true;
    });
  });

  test('the same materials converted correctly pass, every timing measured at 0', async () => {
    for (const [name, sample] of [['motion', { ...motion, audio: 'noise' as const }], ['testsrc2', testsrc], ['still', stillNoise]] as const) {
      const r = await convert({ ...base(), input: makeSample(path.join(work, `m3-ok-${name}.mp4`), sample) });
      assert.equal(r.verification.passed, true, `${name}: ${r.verification.failed.join(',')}`);
      assert.equal(r.verification.audioTiming.status, 'passed', `${name}: ${check(r, 'sync.audio_timing')?.detail}`);
      assert.ok(Math.abs(r.verification.audioTiming.errorMs ?? 99) <= 1, `${name}: ${r.verification.audioTiming.errorMs}`);
      if (name !== 'still') assert.equal(r.verification.videoTiming.status, 'passed', `${name}: ${check(r, 'sync.video_timeline')?.detail}`);
    }
  });
});

describe('M-2: a picture that repeats within the search does not tell the time', { skip: skipNoTools }, () => {
  // Pictures repeating every `period` frames: several source instances match a field equally, and the
  // earliest was taken as its time (a correct 5 Hz output measured +200 ms). The sound is distinctive noise.
  const matrix = [
    ['30000/1001', 6], ['30000/1001', 2], ['30000/1001', 12], ['60000/1001', 12], ['60000/1001', 4], ['60000/1001', 6],
    ['24000/1001', 5], ['25', 5],
  ] as const;
  const periodic = (rate: string, period: number): SampleOptions => ({ rate, motion: true, period, audio: 'noise', seconds: SECONDS, size: '960x540' });
  for (const [rate, period] of matrix) {
    const repeatMs = Math.round(period * 1000 * Number(rate.split('/')[1] ?? 1) / Number(rate.split('/')[0]));
    test(`${rate} fps, picture repeats every ${period} frames (${repeatMs} ms): correct conversion passes, ${repeatMs <= 250 ? 'picture timing ambiguous' : 'picture timing measured'}`, async () => {
      const r = await convert({ ...base(), input: makeSample(path.join(work, `m2-${rate.replace('/', '_')}-${period}.mp4`), periodic(rate, period)) });
      assert.equal(r.verification.passed, true, `${r.verification.failed.join(',')}: ${r.verification.checks.filter((c) => !c.ok).map((c) => c.detail).join(' | ')}`);
      // Never "passed" because one of the equivalent pictures happened to fit.
      assert.equal(r.verification.videoTiming.status, repeatMs <= 250 ? 'unmeasurable' : 'passed', check(r, 'sync.video_timeline')?.detail);
      assert.equal(r.verification.audioTiming.status, 'passed', check(r, 'sync.audio_timing')?.detail);
    });
  }

  const five = periodic('60000/1001', 12); // 200 ms
  test('periodic pictures with a timing error that no repeat explains -> VERIFY_ERROR (33 ms bug, +300 ms)', async () => {
    const src = makeSample(path.join(work, 'm2-fault.mp4'), five);
    const weave = "setfield=tff,separatefields,select='not(mod(n\\,4))+eq(mod(n\\,4)\\,3)',weave=first_field=top";
    const bug33: FrameRatePolicy = { name: 'phase2-33ms', decide: (c) => ({ ...INTERLACED_POLICY.decide(c), filter: `fps=60000/1001,${weave},fps=30000/1001,setfield=tff` }) };
    await assert.rejects(convert({ ...base(), input: src, frameRatePolicy: bug33 }), verifyError(/sync\.video_timeline/, /picture off by at least 3\d(\.\d)? ms/));
    await assert.rejects(convert({ ...base(), input: src, frameRatePolicy: pictureShift(0.3, SECONDS) }), verifyError(/sync\.video_timeline/, /picture off by at least (9\d|10\d)(\.\d)? ms/));
  });

  test('periodic pictures shifted by exactly two repeats cannot be told from correct: ambiguous, not passed', async () => {
    const r = await convert({ ...base(), input: makeSample(path.join(work, 'm2-fault.mp4'), five), frameRatePolicy: pictureShift(0.4004, SECONDS) });
    assert.equal(r.verification.videoTiming.status, 'unmeasurable', check(r, 'sync.video_timeline')?.detail);
  });

  test('periodic pictures + sound 400 ms late -> VERIFY_ERROR from the sound', async () => {
    const tc = faultToolchain(toolchain!, path.join(work, 'fault-m2-audio'), AUDIO_SHIFT(400, SECONDS));
    await assert.rejects(convert({ ...base(), toolchain: tc, input: makeSample(path.join(work, 'm2-fault.mp4'), five) }), verifyError(/sync\.audio_timing/));
  });

  test('60i field order and temporal loss are still caught on periodic pictures with a long repeat (400 ms)', async () => {
    const src = makeSample(path.join(work, 'm2-400.mp4'), periodic('60000/1001', 24));
    const swapped: FrameRatePolicy = { name: 'field-order', decide: (c) => ({ ...INTERLACED_POLICY.decide(c), filter: `${FILTER_INTERLACE_60I},il=ls=1:cs=1` }) };
    await assert.rejects(convert({ ...base(), input: src, frameRatePolicy: swapped }), verifyError(/video\.field_temporal/));
    const loss: FrameRatePolicy = { name: 'loss', decide: (c) => ({ ...INTERLACED_POLICY.decide(c), filter: 'fps=30000/1001:start_time=0' }) };
    await assert.rejects(convert({ ...base(), input: src, frameRatePolicy: loss }), verifyError(/video\.field_temporal/));
  });
});
