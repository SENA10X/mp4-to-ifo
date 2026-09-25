// Beta Hardening M-5: interlaced MP4 input. Each field of the source is its own moment; the DVD (top
// field first) must show every one, in time order, without mixing two fields. Checked with an
// independent reading of the output fields (helpers/motion.ts fieldSequence), not only with the
// core's verification and never with the stream's field_order label alone.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { ConversionError } from '../../src/errors.ts';
import { convert, type ConversionResult } from '../../src/job.ts';
import { INTERLACED_POLICY, type FrameRatePolicy } from '../../src/profile/frame-rate.ts';
import { makeSample, skipNoTools, tempDir, toolchain, type SampleOptions } from '../helpers/env.ts';
import { fieldSequence } from '../helpers/motion.ts';

const work = tempDir();
const out = path.join(work, 'out');
const base = () => ({ toolchain: toolchain!, outputDirectory: out, lock: { dir: path.join(work, 'lock') }, tempRoot: path.join(work, 'jobs'), now: new Date('2026-09-24T00:00:00Z') });
const vobs = (r: ConversionResult) => `concat:${fs.readdirSync(r.videoTsDir).filter((n) => n.endsWith('.VOB')).sort().map((n) => path.join(r.videoTsDir, n)).join('|')}`;
after(() => fs.rmSync(work, { recursive: true, force: true }));

const sample = (name: string, o: SampleOptions) => makeSample(path.join(work, `${name}.mp4`), { motion: true, seconds: 6, ...o });

describe('M-5: interlaced input keeps its fields, in time order, top field first', { skip: skipNoTools }, () => {
  const cases = [
    { name: 'TFF 1080i 29.97', o: { rate: '30000/1001', size: '1920x1080', interlaced: 'tt' }, scan: 'tff', strategy: 'passthrough-29.97' },
    { name: 'BFF 1080i 29.97', o: { rate: '30000/1001', size: '1920x1080', interlaced: 'bb' }, scan: 'bff', strategy: 'passthrough-29.97' },
    { name: 'BFF 480i 29.97 (DV-like, no scaling)', o: { rate: '30000/1001', size: '720x480', interlaced: 'bb' }, scan: 'bff', strategy: 'passthrough-29.97' },
    { name: 'TFF 1080i 30', o: { rate: '30', size: '1920x1080', interlaced: 'tt' }, scan: 'tff', strategy: 'decimate-30' },
  ] as const;
  for (const c of cases) {
    test(`${c.name}: every source field once, in order, none mixed; verification measures the fields`, async () => {
      const r = await convert({ ...base(), input: sample(c.name.replace(/\W+/g, '-'), c.o) });
      assert.equal(r.plan.video.frameRate.strategy, c.strategy);
      assert.equal(r.verification.passed, true, r.verification.failed.join(','));
      const f = fieldSequence(vobs(r), r.plan.video.active);
      assert.equal(f.blended, 0, JSON.stringify(f));
      assert.equal(f.backwards, 0, JSON.stringify(f));
      // 30 -> 29.97 drops one frame (two fields) in 1001: none within 6 s.
      assert.ok(f.next >= f.fields - 2, JSON.stringify(f));
      assert.equal(r.verification.fieldTemporal.status, 'passed', r.verification.fieldTemporal.reason);
      assert.ok(Math.abs(r.verification.fieldTemporal.capacityHz - 60000 / 1001) < 1e-9, 'fields are moments');
      assert.equal(r.verification.videoTiming.status, 'passed', JSON.stringify(r.verification.videoTiming));
    });
  }

  test('TFF and BFF 25i (50 fields/s) -> 59.94i: every field, in order, none mixed', async () => {
    for (const [name, o] of [['TFF 1080i 25', { size: '1920x1080', interlaced: 'tt' }], ['BFF 576i 25', { size: '720x576', interlaced: 'bb' }]] as const) {
      const r = await convert({ ...base(), input: sample(name.replace(/\W+/g, '-'), { rate: '25', ...o }) });
      assert.equal(r.plan.video.frameRate.strategy, 'interlace-60i');
      assert.equal(r.verification.passed, true, `${name}: ${r.verification.failed.join(',')}`);
      const f = fieldSequence(vobs(r), r.plan.video.active);
      assert.equal(f.blended, 0, `${name}: ${JSON.stringify(f)}`);
      assert.equal(f.backwards, 0, `${name}: ${JSON.stringify(f)}`);
      // 50 moments in 59.94 fields: about one field in six repeats, none skipped.
      assert.equal(f.next + f.repeats, f.fields - 1, `${name}: ${JSON.stringify(f)}`);
      assert.ok(f.distinct >= 6 * 50 - 2, `${name}: ${JSON.stringify(f)}`);
      assert.equal(r.verification.fieldTemporal.status, 'passed', `${name}: ${r.verification.fieldTemporal.reason}`);
    }
  });

  test('progressive input is unchanged: both fields of a frame from one picture', async () => {
    const r = await convert({ ...base(), input: sample('progressive-1080', { rate: '30000/1001', size: '1920x1080' }) });
    assert.doesNotMatch(r.plan.video.filter, /interl|fieldorder|estdif/);
    assert.equal(r.verification.passed, true, r.verification.failed.join(','));
    const f = fieldSequence(vobs(r), r.plan.video.active);
    assert.equal(f.blended, 0);
    assert.equal(f.repeats, f.fields / 2, JSON.stringify(f));
  });

  test('fields swapped on the DVD (field order fault) -> VERIFY_ERROR, for TFF and BFF input', async () => {
    const swapped: FrameRatePolicy = { name: 'field-order', decide: (c) => ({ ...INTERLACED_POLICY.decide(c), filter: `${INTERLACED_POLICY.decide(c).filter},il=ls=1:cs=1` }) };
    for (const interlaced of ['tt', 'bb'] as const) {
      const src = sample(`swap-${interlaced}`, { rate: '30000/1001', size: '1920x1080', interlaced });
      await assert.rejects(convert({ ...base(), input: src, frameRatePolicy: swapped }), (e: ConversionError) => {
        assert.equal(e.code, 'VERIFY_ERROR', `${interlaced}: ${e.code} ${e.detail ?? ''}`);
        assert.match(e.reason ?? '', /video\.field_temporal/);
        assert.match(e.detail ?? '', /field steps backwards/);
        return true;
      });
    }
  });
});
