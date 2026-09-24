import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { ConversionError } from '../../src/errors.ts';
import { cleanupStaleJobs, convert, type ConversionResult } from '../../src/job.ts';
import { defaultPlatform } from '../../src/platform.ts';
import { INTERLACED_POLICY, type FrameRatePolicy } from '../../src/profile/frame-rate.ts';
import { inspectToolchain } from '../../src/toolchain.ts';
import { verifyOutput } from '../../src/verify/index.ts';
import { LGPL_BIN, makeSample, skipNoTools, tempDir, toolchain } from '../helpers/env.ts';
import { probeMotion } from '../helpers/motion.ts';

const work = tempDir();
const out = path.join(work, 'out');
const base = () => ({ toolchain: toolchain!, outputDirectory: out, lock: { dir: path.join(work, 'lock') }, tempRoot: path.join(work, 'jobs'), now: new Date('2026-09-24T00:00:00Z') });
const vobs = (r: ConversionResult) => `concat:${fs.readdirSync(r.videoTsDir).filter((n) => n.endsWith('.VOB')).sort().map((n) => path.join(r.videoTsDir, n)).join('|')}`;
const check = (r: ConversionResult, id: string) => r.verification.checks.find((c) => c.id === id);
after(() => fs.rmSync(work, { recursive: true, force: true }));

describe('frame rate strategies (motion samples, field-level timing)', { skip: skipNoTools }, () => {
  const cases = [
    { name: '59.94', rate: '60000/1001', strategy: 'interlace-60i', perSecond: 59.9, syncMs: 2 },
    { name: '50', rate: '50', strategy: 'interlace-60i', perSecond: 49.9, syncMs: 2 },
    { name: '25', rate: '25', strategy: 'interlace-60i', perSecond: 24.9, syncMs: 2 },
    { name: '23.976', rate: '24000/1001', strategy: 'telecine-3-2', perSecond: 23.9, syncMs: 2 },
    // 30 -> 29.97 shows the nearest source frame, so pictures drift within half a frame of the sound.
    { name: '30', rate: '30', strategy: 'decimate-30', perSecond: 29.9, syncMs: 9 },
    { name: '29.97', rate: '30000/1001', strategy: 'passthrough-29.97', perSecond: 29.9, syncMs: 2 },
  ];
  for (const c of cases) {
    test(`${c.name} fps -> ${c.strategy}: every source moment kept, no field lag, A/V in sync`, async () => {
      const src = makeSample(path.join(work, `m-${c.name}.mp4`), { rate: c.rate, motion: true, seconds: 5, size: '960x540' });
      const r = await convert({ ...base(), input: src });
      assert.equal(r.plan.video.frameRate.strategy, c.strategy);
      assert.equal(r.verification.passed, true, r.verification.failed.join(','));
      const m = probeMotion(src, [960, 540], vobs(r), r.plan.video.active);
      assert.ok(m.uniquePerSecond >= c.perSecond, `unique/s ${m.uniquePerSecond}`);
      assert.equal(m.backwards, 0);
      assert.ok(m.timingErrorMaxMs <= 17, `timing ${m.timingErrorMaxMs}`);
      assert.ok(m.avSyncMs !== null && Math.abs(m.avSyncMs) <= c.syncMs, `A/V ${m.avSyncMs}`);
      assert.equal(check(r, 'sync.av_offset')?.status, 'passed', 'clicks make sync measurable');
      assert.equal(check(r, 'video.field_temporal')?.status, 'passed', check(r, 'video.field_temporal')?.detail);
    });
  }

  test('VFR starting one 60p frame after the audio -> 59.94i without a field of lag', async () => {
    const src = makeSample(path.join(work, 'm-vfr.mp4'), { rate: '60', vfr: true, motion: true, seconds: 6, size: '960x540', videoDelay: 1 / 60 });
    const r = await convert({ ...base(), input: src });
    assert.equal(r.plan.warnings.some((w) => w.code === 'VARIABLE_FRAME_RATE'), true);
    assert.equal(r.verification.passed, true, r.verification.failed.join(','));
    const m = probeMotion(src, [960, 540], vobs(r), r.plan.video.active);
    assert.equal(m.backwards, 0);
    assert.ok(m.avSyncMs !== null && Math.abs(m.avSyncMs) <= 5, `A/V ${m.avSyncMs}`); // 60 -> 59.94 drifts ~1 ms/s
  });
});

describe('A/V sync verification catches the Phase 2 timing bugs', { skip: skipNoTools }, () => {
  const buggy = (name: string, filter: string): FrameRatePolicy => ({
    name,
    decide: (c) => ({ ...INTERLACED_POLICY.decide(c), filter }),
  });
  const weave = "setfield=tff,separatefields,select='not(mod(n\\,4))+eq(mod(n\\,4)\\,3)',weave=first_field=top";

  test('59.94 weave with round=near (picture one frame late) fails verification', async () => {
    const src = makeSample(path.join(work, 'bug-5994.mp4'), { rate: '60000/1001', motion: true, seconds: 5, size: '960x540' });
    const policy = buggy('phase2-33ms', `fps=60000/1001,${weave},fps=30000/1001,setfield=tff`);
    await assert.rejects(convert({ ...base(), input: src, frameRatePolicy: policy }), (e: ConversionError) => {
      assert.equal(e.code, 'VERIFY_ERROR');
      assert.match(e.reason ?? '', /sync\.av_offset/);
      assert.match(e.detail ?? '', /introduced 3\d\.\d ms/);
      return true;
    });
  });

  test('59.94 bug is caught without audio as well (video timeline check)', async () => {
    const src = makeSample(path.join(work, 'bug-5994-silent.mp4'), { rate: '60000/1001', motion: true, seconds: 5, size: '960x540', audio: 'none' });
    const policy = buggy('phase2-33ms', `fps=60000/1001,${weave},fps=30000/1001,setfield=tff`);
    await assert.rejects(convert({ ...base(), input: src, frameRatePolicy: policy }), (e: ConversionError) => /sync\.video_timeline/.test(e.reason ?? ''));
  });

  test('VFR without start_time=0 (one field late) fails verification', async () => {
    const src = makeSample(path.join(work, 'bug-vfr.mp4'), { rate: '60', vfr: true, motion: true, seconds: 6, size: '960x540', videoDelay: 1 / 60 });
    const policy = buggy('vfr-no-origin', `fps=60000/1001,${weave},fps=30000/1001:round=down,setfield=tff`);
    await assert.rejects(convert({ ...base(), input: src, frameRatePolicy: policy }), (e: ConversionError) => e.code === 'VERIFY_ERROR' && /sync\./.test(e.reason ?? ''));
  });
});

describe('audio strategies', { skip: skipNoTools }, () => {
  const levels = (file: string) => {
    const stderr = spawnSync(toolchain!.ffmpeg, ['-hide_banner', '-i', file, '-map', '0:a:0', '-af', 'astats=measure_perchannel=Peak_level:measure_overall=none', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    return [...stderr.matchAll(/Peak level dB: (-?[\d.]+)/g)].map((m) => Number(m[1]));
  };

  test('5.1 too loud for stereo is attenuated to -1 dBFS, never boosted', async () => {
    const r = await convert({ ...base(), input: makeSample(path.join(work, 'loud51.mp4'), { audio: '5.1-loud' }) });
    assert.equal(r.plan.audio?.strategy, 'downmix-5.1');
    assert.ok((r.audio.peakDbfs ?? 0) > -1 && r.audio.gainDb < 0, JSON.stringify(r.audio));
    for (const p of levels(path.join(r.videoTsDir, 'VTS_01_1.VOB'))) assert.ok(p <= -0.9, `peak ${p}`);
  });

  test('normal 5.1 keeps its level (gain 0)', async () => {
    const r = await convert({ ...base(), input: makeSample(path.join(work, 'n51.mp4'), { audio: '5.1' }) });
    assert.equal(r.audio.gainDb, 0);
  });

  test('mono becomes L = R at the source level', async () => {
    const src = makeSample(path.join(work, 'mono.mp4'), { audio: 'mono' });
    const r = await convert({ ...base(), input: src });
    const [l, rr] = levels(path.join(r.videoTsDir, 'VTS_01_1.VOB'));
    const [s] = levels(src);
    assert.ok(Math.abs((l ?? 0) - (s ?? 0)) < 0.3 && Math.abs((rr ?? 0) - (s ?? 0)) < 0.3, `${l} ${rr} vs ${s}`);
  });

  test('no audio: silent AC-3 stereo 48 kHz as long as the video', async () => {
    const r = await convert({ ...base(), input: makeSample(path.join(work, 'noaudio.mp4'), { audio: 'none' }) });
    assert.equal(r.plan.audio?.strategy, 'silence');
    const d = r.verification.durations;
    assert.ok(Math.abs(d.audio - d.video) <= 0.032 + 1e-6, `audio ${d.audio} video ${d.video}`);
    assert.ok(check(r, 'streams.audio')?.ok);
  });
});

describe('cancellation', { skip: skipNoTools }, () => {
  test('abort during pass 1 stops ffmpeg, removes temp and staging, releases the lock', async () => {
    const tempRoot = path.join(work, 'jobs-cancel');
    const src = makeSample(path.join(work, 'cancel.mp4'), { seconds: 30, size: '1280x720' });
    const controller = new AbortController();
    const started = Date.now();
    await assert.rejects(
      convert({ ...base(), tempRoot, input: src, signal: controller.signal, onProgress: (e) => {
        if (e.phase === 'ENCODING_PASS_1' && (e.phaseProgress ?? 0) > 0.1) controller.abort();
      } }),
      (e: ConversionError) => e.code === 'CANCELLED',
    );
    assert.ok(Date.now() - started < 60_000);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
    assert.deepEqual(fs.readdirSync(out).filter((n) => n.startsWith('.mp4-to-ifo-')), []);
    assert.equal(fs.existsSync(path.join(work, 'lock', 'conversion.lock')), false);
    const ps = execFileSync('ps', ['-axo', 'command']).toString();
    assert.ok(!ps.includes(tempRoot), 'no child process left');
  });

  test('an already aborted signal never starts', async () => {
    const c = new AbortController();
    c.abort();
    await assert.rejects(convert({ ...base(), input: path.join(work, 'cancel.mp4'), signal: c.signal }), (e: ConversionError) => e.code === 'CANCELLED');
  });
});

describe('fault injection: verification detects damaged output', { skip: skipNoTools }, () => {
  let good: ConversionResult;
  before(async () => {
    good = await convert({ ...base(), input: makeSample(path.join(work, 'fault.mp4'), { seconds: 5 }) });
  });
  const damaged = async (name: string, damage: (dir: string) => void) => {
    const dir = path.join(work, `fault-${name}`);
    fs.cpSync(good.outputDir, dir, { recursive: true });
    damage(dir);
    return verifyOutput({ plan: good.plan, dir, toolchain: toolchain!, platform: defaultPlatform() });
  };
  const patch = (file: string, at: number, bytes: Buffer) => {
    const fd = fs.openSync(file, 'r+');
    fs.writeSync(fd, bytes, 0, bytes.length, at);
    fs.closeSync(fd);
  };

  test('undamaged copy passes', async () => {
    assert.equal((await damaged('none', () => {})).passed, true);
  });
  test('corrupted VOB', async () => {
    const r = await damaged('vob', (d) => patch(path.join(d, 'VIDEO_TS/VTS_01_1.VOB'), 400_000, Buffer.alloc(200_000, 0x55)));
    assert.ok(r.failed.includes('decode.full') || r.failed.includes('vob.packs'), r.failed.join(','));
  });
  test('region mask set in both IFO and BUP', async () => {
    const r = await damaged('region', (d) => {
      patch(path.join(d, 'VIDEO_TS/VIDEO_TS.IFO'), 0x23, Buffer.from([0x01]));
      patch(path.join(d, 'VIDEO_TS/VIDEO_TS.BUP'), 0x23, Buffer.from([0x01]));
    });
    assert.ok(r.failed.includes('ifo.region_free'), r.failed.join(','));
  });
  test('BUP differs from IFO', async () => {
    const r = await damaged('bup', (d) => patch(path.join(d, 'VIDEO_TS/VTS_01_0.BUP'), 100, Buffer.from([0xff])));
    assert.ok(r.failed.includes('videots.bup_equals_ifo'), r.failed.join(','));
  });
  test('missing VTS BUP', async () => {
    const r = await damaged('missing', (d) => fs.rmSync(path.join(d, 'VIDEO_TS/VTS_01_0.BUP')));
    assert.ok(r.failed.includes('videots.files'), r.failed.join(','));
  });
  test('UDF descriptor damaged in the ISO', async () => {
    const r = await damaged('udf', (d) => patch(path.join(d, good.plan.output.isoFileName), 35 * 2048 + 100, Buffer.from([0xaa])));
    assert.ok(r.failed.includes('iso.structure'), r.failed.join(','));
  });
  test('ISO file data damaged', async () => {
    const r = await damaged('isodata', (d) => {
      const f = path.join(d, good.plan.output.isoFileName);
      patch(f, fs.statSync(f).size - 2048 * 10, Buffer.alloc(512, 0x11));
    });
    assert.ok(r.failed.includes('iso.content'), r.failed.join(','));
  });
  test('ZIP data damaged', async () => {
    const r = await damaged('zip', (d) => patch(path.join(d, 'VIDEO_TS.zip'), 50_000, Buffer.from([0x00, 0x01, 0x02])));
    assert.ok(r.failed.includes('zip.crc'), r.failed.join(','));
  });
});

describe('LGPL FFmpeg', { skip: skipNoTools }, () => {
  test('the pipeline runs on the LGPL build and never uses GPL-only filters', { skip: toolchain?.ffmpeg.startsWith(LGPL_BIN) ? false : 'LGPL build not present' }, async () => {
    const report = await inspectToolchain(toolchain!);
    assert.equal(report.ffmpeg.license, 'lgpl');
    assert.deepEqual(report.missing, []);
    assert.deepEqual(report.missingExperimental, []);
    assert.doesNotMatch(report.ffmpeg.configuration, /--enable-(gpl|nonfree)/);
  });
});

describe('stale job cleanup', { skip: skipNoTools }, () => {
  test('removes folders of dead processes and their staging, keeps live ones', async () => {
    const root = path.join(work, 'stale');
    const outDir = path.join(work, 'stale-out');
    fs.mkdirSync(outDir, { recursive: true });
    const child = spawn(process.execPath, ['-e', '0']);
    await new Promise((r) => child.on('exit', r));
    const deadStaging = path.join(outDir, '.mp4-to-ifo-dead.partial');
    fs.mkdirSync(deadStaging);
    fs.mkdirSync(path.join(root, 'job-dead'), { recursive: true });
    fs.writeFileSync(path.join(root, 'job-dead', 'owner.json'), JSON.stringify({ pid: child.pid, processStart: 'x', staging: deadStaging }));
    const platform = defaultPlatform();
    fs.mkdirSync(path.join(root, 'job-live'));
    fs.writeFileSync(path.join(root, 'job-live', 'owner.json'), JSON.stringify({ pid: process.ppid, processStart: await platform.processStartTime(process.ppid), staging: path.join(outDir, 'x') }));
    const userDir = path.join(outDir, 'wedding');
    fs.mkdirSync(userDir);
    assert.equal(await cleanupStaleJobs({ tempRoot: root, platform }), 1);
    assert.equal(fs.existsSync(deadStaging), false);
    assert.equal(fs.existsSync(path.join(root, 'job-live')), true);
    assert.equal(fs.existsSync(userDir), true);
  });
});

