// Phase 5.2: correct material whose pictures repeat (low-motion content in a high-rate file, slideshows)
// must not fail picture timing, while the real timing faults still fail on the same material.
// Faults are injected on the production path (a frame-rate policy, or an ffmpeg wrapper for the final
// encode) or by editing output bytes; nothing in the core is aware of them.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ConversionError } from '../../src/errors.ts';
import { writeDvdIso } from '../../src/iso/writer.ts';
import { convert, type ConversionResult } from '../../src/job.ts';
import { FILTER_INTERLACE_60I, INTERLACED_POLICY, type FrameRatePolicy } from '../../src/profile/frame-rate.ts';
import { verifyOutput } from '../../src/verify/index.ts';
import { syncWindows } from '../../src/verify/sync.ts';
import { writeZip } from '../../src/zip.ts';
import { AUDIO_DELAY, faultToolchain } from '../helpers/fault.ts';
import { makeSample, skipNoTools, tempDir, toolchain } from '../helpers/env.ts';

const work = tempDir();
const out = path.join(work, 'out');
const base = () => ({ toolchain: toolchain!, outputDirectory: out, lock: { dir: path.join(work, 'lock') }, tempRoot: path.join(work, 'jobs'), now: new Date('2026-09-24T00:00:00Z') });
const check = (r: ConversionResult, id: string) => r.verification.checks.find((c) => c.id === id);
after(() => fs.rmSync(work, { recursive: true, force: true }));

const verifyError = (pattern: RegExp) => (e: ConversionError) => {
  assert.equal(e.code, 'VERIFY_ERROR', `${e.code} ${e.message} ${e.detail ?? ''}`);
  assert.match(e.reason ?? '', pattern);
  return true;
};

/** The historical Phase 2 chains, injected as policies (as in pipeline.test.ts). */
const weave = "setfield=tff,separatefields,select='not(mod(n\\,4))+eq(mod(n\\,4)\\,3)',weave=first_field=top";
const policy = (name: string, filter: string): FrameRatePolicy => ({ name, decide: (c) => ({ ...INTERLACED_POLICY.decide(c), filter }) });
const BUG_33MS = policy('phase2-33ms', `fps=60000/1001,${weave},fps=30000/1001,setfield=tff`);
const BUG_VFR_START = policy('vfr-no-origin', `fps=60000/1001,${weave},fps=30000/1001:round=down,setfield=tff`);

describe('H3: repeated pictures are one moment, not a precise time', { skip: skipNoTools }, () => {
  for (const content of ['30', '15', '10', '6']) {
    test(`REG-LOW-MOTION-${content}: ${content} fps content in a 60 fps file passes`, async () => {
      const src = makeSample(path.join(work, `low-${content}.mp4`), { rate: '60', contentRate: content, motion: true, seconds: 5, size: '960x540' });
      const r = await convert({ ...base(), input: src });
      assert.equal(r.verification.passed, true, `${r.verification.failed.join(',')}: ${r.verification.checks.filter((c) => !c.ok).map((c) => c.detail).join(' | ')}`);
      assert.notEqual(check(r, 'sync.video_timeline')?.status, 'failed');
      if (r.verification.videoTiming.status === 'passed') assert.ok(Math.abs(r.verification.videoTiming.errorMs ?? 99) <= 1, String(r.verification.videoTiming.errorMs));
    });
  }

  test('REG-LOW-MOTION-15 on colourful content (testsrc2 at 15 fps in a 60 fps file) passes', async () => {
    const r = await convert({ ...base(), input: makeSample(path.join(work, 'low-15-testsrc.mp4'), { rate: '60', contentRate: '15', seconds: 5, size: '1280x720' }) });
    assert.equal(r.verification.passed, true, r.verification.failed.join(','));
  });

  for (const kind of ['cut', 'crossfade'] as const) {
    test(`REG-SLIDESHOW (${kind}): three photos pass`, async () => {
      const seconds = kind === 'cut' ? 9 : 7;
      const r = await convert({ ...base(), input: makeSample(path.join(work, `slides-${kind}.mp4`), { slideshow: kind, audio: 'clicks', seconds, rate: '30000/1001', size: '1280x720' }) });
      assert.equal(r.verification.passed, true, r.verification.failed.join(','));
      assert.notEqual(check(r, 'sync.video_timeline')?.status, 'failed');
      assert.equal(r.verification.audioTiming.status, 'passed', JSON.stringify(r.verification.audioTiming));
    });
  }

  test('slideshow + audio delayed 100 ms -> VERIFY_ERROR from sound timing alone', async () => {
    const src = makeSample(path.join(work, 'slides-late.mp4'), { slideshow: 'cut', audio: 'clicks', seconds: 9, size: '1280x720' });
    const tc = faultToolchain(toolchain!, path.join(work, 'fault-slides'), AUDIO_DELAY(100));
    await assert.rejects(convert({ ...base(), toolchain: tc, input: src }), verifyError(/sync\.audio_timing/));
  });

  test('REG-33MS still fails on low-motion content (15 fps in 60)', async () => {
    const src = makeSample(path.join(work, 'low-15-bug.mp4'), { rate: '60', contentRate: '15', motion: true, seconds: 5, size: '960x540' });
    await assert.rejects(convert({ ...base(), input: src, frameRatePolicy: BUG_33MS }), (e: ConversionError) => {
      verifyError(/sync\.(video_timeline|av_offset)/)(e);
      assert.match(e.detail ?? '', /picture \+3\d\.\d ms|picture \+33 ms|introduced 3\d/);
      return true;
    });
  });

  test('REG-33MS and REG-VFR-START still fail on full-motion content', async () => {
    const m = makeSample(path.join(work, 'full-5994.mp4'), { rate: '60000/1001', motion: true, seconds: 5, size: '960x540' });
    await assert.rejects(convert({ ...base(), input: m, frameRatePolicy: BUG_33MS }), verifyError(/sync\.(video_timeline|av_offset)/));
    const vfr = makeSample(path.join(work, 'vfr-start.mp4'), { rate: '60', vfr: true, motion: true, seconds: 6, size: '960x540', videoDelay: 1 / 60 });
    await assert.rejects(convert({ ...base(), input: vfr, frameRatePolicy: BUG_VFR_START }), verifyError(/sync\./));
  });
});

describe('M5: every MPEG-2 sequence extension is checked, not only the first', { skip: skipNoTools }, () => {
  let good: ConversionResult;
  before(async () => {
    good = await convert({ ...base(), input: makeSample(path.join(work, 'seqext.mp4'), { seconds: 5 }) });
  });

  /** Offsets of sequence extensions (00 00 01 B5, id 1) whose bytes lie inside one 2048-byte pack. */
  const extensions = (b: Buffer) => {
    const at: number[] = [];
    for (let i = b.indexOf(Buffer.from([0, 0, 1, 0xb5])); i >= 0; i = b.indexOf(Buffer.from([0, 0, 1, 0xb5]), i + 4)) {
      if (b[i + 4]! >> 4 === 1 && (i % 2048) + 10 <= 2048) at.push(i);
    }
    return at;
  };

  /** Set frame_rate_extension_n = 1 (double rate) in one sequence extension; ZIP and ISO rebuilt so only that differs. */
  const corrupt = async (which: 'none' | 'first' | 'second' | 'middle' | 'last') => {
    const dir = path.join(work, `seqext-${which}`);
    fs.cpSync(good.outputDir, dir, { recursive: true });
    const vob = path.join(dir, 'VIDEO_TS/VTS_01_1.VOB');
    const b = fs.readFileSync(vob);
    const ext = extensions(b);
    assert.ok(ext.length >= 5, `${ext.length} sequence extensions`);
    const index = { none: -1, first: 0, second: 1, middle: ext.length >> 1, last: ext.length - 1 }[which];
    if (index >= 0) {
      const i = ext[index]!;
      b[i + 9] = (b[i + 9]! & 0x80) | (1 << 5);
      fs.writeFileSync(vob, b);
    }
    const date = new Date('2026-09-24T00:00:00Z');
    fs.rmSync(path.join(dir, 'VIDEO_TS.zip'));
    fs.rmSync(path.join(dir, good.plan.output.isoFileName));
    await writeZip(path.join(dir, 'VIDEO_TS'), path.join(dir, 'VIDEO_TS.zip'), { date });
    await writeDvdIso(path.join(dir, 'VIDEO_TS'), path.join(dir, good.plan.output.isoFileName), { volumeLabel: good.plan.output.volumeLabel, date });
    return verifyOutput({ plan: good.plan, dir, toolchain: toolchain! });
  };

  test('all sequence extensions correct -> PASS', async () => {
    const r = await corrupt('none');
    assert.equal(r.passed, true, r.failed.join(','));
  });
  for (const which of ['first', 'second', 'middle', 'last'] as const) {
    test(`${which} sequence extension with a wrong frame_rate_extension -> mpeg2.frame_rate fails`, async () => {
      const r = await corrupt(which);
      assert.equal(r.passed, false);
      assert.ok(r.failed.includes('mpeg2.frame_rate'), r.failed.join(','));
    });
  }
});

describe('M7: a temporal fault inside one sampled window is not averaged away', { skip: skipNoTools }, () => {
  test('60i temporal loss only across the second window of a 20 s clip -> VERIFY_ERROR', async () => {
    // A 29.97p copy is laid over the correct 59.94i output for the length of one sampling window.
    // (A fault between windows is not sampled at all: docs/core.md §11.)
    const centre = syncWindows(20)[1]!;
    const [from, to] = [centre - 0.6, centre + 0.9];
    const local = policy('fi-60i-local-loss', `split[a][b];[a]${FILTER_INTERLACE_60I}[x];[b]fps=30000/1001:start_time=0,setfield=tff[y];[x][y]overlay=enable='between(t,${from},${to})'`);
    const src = makeSample(path.join(work, 'local-loss.mp4'), { rate: '60000/1001', motion: true, seconds: 20, size: '960x540' });
    await assert.rejects(convert({ ...base(), input: src, frameRatePolicy: local }), (e: ConversionError) => {
      verifyError(/video\.field_temporal/)(e);
      assert.match(e.detail ?? '', /worst of \d windows: coverage 0\.[4-6]/);
      return true;
    });
  });
});
