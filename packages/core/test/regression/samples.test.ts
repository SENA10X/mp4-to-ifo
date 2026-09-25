// Regression against the Phase 2 PoC samples (samples/, not in git) and PoC results
// (output/regression-lgpl/*.log). Writes output/core-regression/results.json.
// Run: npm run test:regression -w @mp4-to-ifo/core

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { sha256File } from '../../src/fsutil.ts';
import { convert } from '../../src/job.ts';
import { REPO, toolchain } from '../helpers/env.ts';

const samples = path.join(REPO, 'samples');
const pocDir = path.join(REPO, 'output/regression-lgpl');
const outRoot = path.join(REPO, 'output/core-regression');
const skip = !toolchain ? 'no toolchain' : !fs.existsSync(samples) ? 'samples/ not present' : false;

const ONLY = process.env.REGRESSION_ONLY?.split(',');
const ALL = [
  'standard-16x9', 'aspect-4x3', 'vertical-1080x1920', 'rotated-90', 'fps-30', 'fps-59.94', 'fps-23.976',
  'audio-5.1', 'audio-5.1-loud', 'audio-mono', 'no-audio', 'motion/m-60000_1001', 'motion/m-50', 'motion/m-25',
  'motion/m-24000_1001', 'motion/m-vfr', 'long-20min-noise',
];
const CASES = ONLY ? ALL.filter((c) => ONLY.includes(c)) : ALL;

interface Row {
  sample: string;
  passed: boolean;
  failed: string[];
  checks: number;
  strategy: string;
  durations: { expectedVideo: number; video: number; audio: number; ifo: number };
  poc: { video: number; audio: number; ifo: number; seconds: number } | null;
  sync: { status: string; videoMs: number | null; audioMs: number | null; introducedMs: number | null; videoTimelineMs: number | null };
  timing: { video: string; audio: string; relativeAv: string; audioErrorMs: number | null };
  fieldTemporal: { status: string; coverage: number | null; backwardRatio: number | null; clearMoments: number; residual: number };
  statuses: Record<string, number>;
  vobStartDeltaMs: string;
  audio: { peakDbfs: number | null; gainDb: number };
  seconds: number;
  encodeSeconds: number;
  verifySeconds: number;
}

const rows: Row[] = [];

function pocResult(name: string) {
  const log = path.join(pocDir, `${path.basename(name)}.log`);
  if (!fs.existsSync(log)) return null;
  const text = fs.readFileSync(log, 'utf8');
  const m = /DVD video ([\d.]+)s \| DVD audio ([\d.]+)s \| IFO ([\d.]+)s/.exec(text);
  const t = /total time\s+([\d.]+)s/.exec(text);
  return m ? { video: Number(m[1]), audio: Number(m[2]), ifo: Number(m[3]), seconds: Number(t?.[1] ?? 0) } : null;
}

describe('PoC sample regression', { skip }, () => {
  after(() => {
    fs.mkdirSync(outRoot, { recursive: true });
    fs.writeFileSync(path.join(outRoot, ONLY ? 'results-partial.json' : 'results.json'), JSON.stringify(rows, null, 2));
  });

  for (const name of CASES) {
    const input = path.join(samples, `${name}.mp4`);
    test(name, { skip: fs.existsSync(input) ? false : 'sample missing' }, async () => {
      const out = path.join(outRoot, path.dirname(name));
      fs.rmSync(path.join(out, path.basename(name)), { recursive: true, force: true });
      const before = await sha256File(input);
      const t0 = Date.now();
      const r = await convert({ input, toolchain: toolchain!, outputDirectory: out, requireLgpl: true, lock: { dir: path.join(outRoot, '.lock') } });
      const seconds = (Date.now() - t0) / 1000;
      assert.equal(await sha256File(input), before, 'source unchanged');
      const vs = r.verification.checks.find((c) => c.id === 'vob.av_start')?.detail ?? '';
      rows.push({
        sample: name,
        passed: r.verification.passed,
        failed: r.verification.failed,
        checks: r.verification.checks.length,
        strategy: r.plan.video.frameRate.strategy,
        durations: r.verification.durations,
        poc: pocResult(name),
        sync: {
          status: r.verification.sync.status,
          videoMs: r.verification.sync.videoOffsetMs,
          audioMs: r.verification.sync.audioOffsetMs,
          introducedMs: r.verification.sync.introducedOffsetMs,
          videoTimelineMs: r.verification.sync.videoTimelineErrorMs,
        },
        timing: {
          video: r.verification.videoTiming.status,
          audio: r.verification.audioTiming.status,
          relativeAv: r.verification.relativeAvTiming.status,
          audioErrorMs: r.verification.audioTiming.errorMs,
        },
        fieldTemporal: {
          status: r.verification.fieldTemporal.status,
          coverage: r.verification.fieldTemporal.coverage,
          backwardRatio: r.verification.fieldTemporal.backwardRatio,
          clearMoments: r.verification.fieldTemporal.stats.sourceMoments,
          residual: Math.round(r.verification.fieldTemporal.stats.residual * 10000) / 10000,
        },
        statuses: r.verification.checks.reduce<Record<string, number>>((m, c) => ({ ...m, [c.status]: (m[c.status] ?? 0) + 1 }), {}),
        vobStartDeltaMs: vs,
        audio: r.audio,
        seconds,
        encodeSeconds: ((r.timingsMs.ENCODING_PASS_1 ?? 0) + (r.timingsMs.ENCODING_PASS_2 ?? 0)) / 1000,
        verifySeconds: (r.timingsMs.VERIFYING ?? 0) / 1000,
      });
      assert.equal(r.verification.passed, true, r.verification.failed.join(','));
      // The core keeps the last frame the PoC's fps filter dropped: CFR video ends within one frame of
      // the source end. (VFR containers do not record the last frame's duration, so only the
      // verification tolerance applies there.)
      if (r.plan.video.frameRate.inputClass !== 'variable') {
        assert.ok(Math.abs(r.verification.durations.video - r.verification.durations.expectedVideo) <= 1001 / 30000 + 1e-6);
      }
    });
  }
});

describe('BH-H1: real footage with a fade through black', { skip }, () => {
  test('opening-movie faded out and in across the second sampling window passes, picture timing measured', async () => {
    const input = path.join(samples, 'opening-movie.mp4');
    const dir = path.join(outRoot, 'bh-h1');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const faded = path.join(dir, 'opening-fade.mp4');
    // 20 s clip, windows at 3/7/11/15/18 s: out over 6.0-6.8 s, in over 7.0-7.8 s.
    execFileSync(toolchain!.ffmpeg, ['-v', 'error', '-i', input, '-filter_complex',
      '[0:v]split[a][b];[a]trim=0:7,fade=t=out:st=6:d=0.8[x];[b]trim=7,setpts=PTS-STARTPTS,fade=t=in:st=0:d=0.8[y];[x][y]concat[v]',
      '-map', '[v]', '-map', '0:a', '-r', '30000/1001', '-c:v', 'mpeg4', '-q:v', '2', '-c:a', 'copy', faded]);
    const r = await convert({ input: faded, toolchain: toolchain!, outputDirectory: dir, requireLgpl: true, lock: { dir: path.join(outRoot, '.lock') } });
    assert.equal(r.verification.passed, true, r.verification.failed.join(','));
    assert.equal(r.verification.videoTiming.status, 'passed', JSON.stringify(r.verification.videoTiming));
    assert.equal(r.verification.fieldTemporal.status, 'passed', r.verification.fieldTemporal.reason);
  });
});
