import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { analyzeInput } from '../../src/analyze.ts';
import { sha256File } from '../../src/fsutil.ts';
import { inspectIso } from '../../src/iso/reader.ts';
import type { ConversionError } from '../../src/errors.ts';
import { analyzeAndPlan, convert, type ConversionResult, type ProgressEvent } from '../../src/job.ts';
import { planDigest } from '../../src/plan.ts';
import { defaultPlatform } from '../../src/platform.ts';
import { makeSample, skipNoTools, tempDir, toolchain, which } from '../helpers/env.ts';

const work = tempDir();
const out = path.join(work, 'out');
const lockDir = path.join(work, 'lock');
const tempRoot = path.join(work, 'jobs');
const opts = () => ({ toolchain: toolchain!, outputDirectory: out, lock: { dir: lockDir }, tempRoot, now: new Date('2026-09-24T00:00:00Z') });

describe('input analysis', { skip: skipNoTools }, () => {
  test('standard, rotated, VFR, channel layouts, subtitles', async () => {
    const tc = toolchain!;
    const std = await analyzeInput(makeSample(path.join(work, 'a-std.mp4')), tc);
    assert.equal(std.video.width, 640);
    assert.ok(Math.abs(std.video.displayAspectRatio - 16 / 9) < 1e-3);
    assert.equal(std.video.isVariableFrameRate, false);
    assert.equal(std.audioTracks[0]?.channels, 2);

    const rot = await analyzeInput(makeSample(path.join(work, 'a-rot.mp4'), { rotation: 90 }), tc);
    assert.equal(Math.abs(rot.video.rotation), 90);
    assert.ok(Math.abs(rot.video.displayAspectRatio - 9 / 16) < 1e-3);

    const vfr = await analyzeInput(makeSample(path.join(work, 'a-vfr.mp4'), { rate: '60', vfr: true, seconds: 6 }), tc);
    assert.equal(vfr.video.isVariableFrameRate, true);

    assert.equal((await analyzeInput(makeSample(path.join(work, 'a-51.mp4'), { audio: '5.1' }), tc)).audioTracks[0]?.channelLayout, '5.1');
    assert.equal((await analyzeInput(makeSample(path.join(work, 'a-mono.mp4'), { audio: 'mono' }), tc)).audioTracks[0]?.channels, 1);
    const none = await analyzeInput(makeSample(path.join(work, 'a-none.mp4'), { audio: 'none' }), tc);
    assert.equal(none.selectedAudio, null);
    const subs = await analyzeInput(makeSample(path.join(work, 'a-subs.mp4'), { subtitles: true }), tc);
    assert.equal(subs.subtitleTracks.length, 1);
  });

  test('invalid inputs are INPUT_ERROR before any conversion', async () => {
    const tc = toolchain!;
    const src = makeSample(path.join(work, 'b-full.mp4'), { seconds: 6 });
    const truncated = path.join(work, 'b-trunc.mp4');
    const buf = fs.readFileSync(src);
    fs.writeFileSync(truncated, buf.subarray(0, Math.floor(buf.length / 2)));
    const fake = path.join(work, 'b-fake.mp4');
    fs.writeFileSync(fake, 'not a video');
    const mov = path.join(work, 'b.mov');
    fs.copyFileSync(src, mov);
    const reason = (p: string) => analyzeInput(p, tc).then(() => 'ok', (e: { code: string; reason: string }) => `${e.code}:${e.reason}`);
    assert.equal(await reason(truncated), 'INPUT_ERROR:TRUNCATED');
    assert.match(await reason(fake), /^INPUT_ERROR:/);
    assert.equal(await reason(mov), 'INPUT_ERROR:NOT_MP4');
    assert.equal(await reason(path.join(work, 'missing.mp4')), 'INPUT_ERROR:UNREADABLE');
  });
});

describe('conversion', { skip: skipNoTools }, () => {
  let source = '';
  let sourceHash = '';
  let sourceStat: fs.Stats;
  let result: ConversionResult;
  const events: ProgressEvent[] = [];

  before(async () => {
    source = makeSample(path.join(work, 'オープニング ムービー 2026.mp4'), { seconds: 5 });
    sourceHash = await sha256File(source);
    sourceStat = fs.statSync(source);
    result = await convert({ ...opts(), input: source, onProgress: (e) => events.push(e) });
  });
  after(() => fs.rmSync(work, { recursive: true, force: true }));

  test('passes verification and writes exactly VIDEO_TS, VIDEO_TS.zip and <name>.iso', () => {
    assert.equal(result.verification.passed, true, result.verification.failed.join(','));
    assert.equal(path.basename(result.outputDir), 'オープニング ムービー 2026');
    assert.deepEqual(fs.readdirSync(result.outputDir).sort(), ['VIDEO_TS', 'VIDEO_TS.zip', 'オープニング ムービー 2026.iso'].sort());
    assert.deepEqual(fs.readdirSync(out).filter((n) => n.startsWith('.')), []); // no staging left
    assert.deepEqual(fs.existsSync(tempRoot) ? fs.readdirSync(tempRoot) : [], []); // no job folder left
    assert.equal(fs.existsSync(path.join(lockDir, 'conversion.lock')), false);
    assert.equal(result.plan.output.volumeLabel, '2026'); // Japanese dropped, digits kept
    assert.ok(result.verification.checks.length >= 45);
  });

  test('source MP4 is untouched (sha256, size, mtime)', async () => {
    assert.equal(await sha256File(source), sourceHash);
    const st = fs.statSync(source);
    assert.equal(st.size, sourceStat.size);
    assert.equal(st.mtimeMs, sourceStat.mtimeMs);
  });

  test('progress: phases in order, overall progress monotonic, media time while encoding', () => {
    const phases = [...new Set(events.map((e) => e.phase))];
    assert.deepEqual(phases, ['ANALYZING', 'PREFLIGHT', 'ENCODING_PASS_1', 'ENCODING_PASS_2', 'AUTHORING', 'CREATING_ZIP', 'CREATING_ISO', 'VERIFYING', 'FINALIZING', 'COMPLETED']);
    for (let i = 1; i < events.length; i++) assert.ok((events[i]?.overallProgress ?? 0) >= (events[i - 1]?.overallProgress ?? 0) - 1e-9);
    assert.ok(events.some((e) => e.phase === 'ENCODING_PASS_2' && (e.mediaTime ?? 0) > 1 && e.mediaDuration !== undefined));
    assert.equal(events.at(-1)?.overallProgress, 1);
  });

  test('planDigest: the accepted plan converts; a plan that no longer matches is refused before any work', async () => {
    const { plan } = await analyzeAndPlan(source, { toolchain: toolchain!, outputDirectory: out });
    const again = (await analyzeAndPlan(source, { toolchain: toolchain!, outputDirectory: out })).plan;
    assert.equal(planDigest(plan), planDigest(again), 'the same input and folder give the same plan');
    // The first conversion was planned before the output folder existed: that plan has no folder identity.
    assert.equal(result.plan.output.directoryId, null);
    assert.match(plan.output.directoryId ?? '', /^\d+:\d+$/);
    const stale = planDigest({ ...plan, video: { ...plan.video, bitrateKbps: 1 } });
    const phases: string[] = [];
    await assert.rejects(convert({ ...opts(), input: source, planDigest: stale, onProgress: (e) => phases.push(e.phase) }),
      (e: ConversionError) => e.code === 'INPUT_ERROR' && e.reason === 'PLAN_CHANGED');
    assert.deepEqual([...new Set(phases)], ['ANALYZING']);
    assert.deepEqual(fs.readdirSync(out).filter((n) => n.startsWith('.')), []);
  });

  test('same name again becomes <name>-2', async () => {
    const { plan } = await analyzeAndPlan(source, { toolchain: toolchain!, outputDirectory: out });
    const second = await convert({ ...opts(), input: source, planDigest: planDigest(plan) });
    assert.equal(path.basename(second.outputDir), 'オープニング ムービー 2026-2');
  });

  test('ZIP opens with Info-ZIP unzip', { skip: which('unzip') ? false : 'unzip not available' }, () => {
    const r = execFileSync('unzip', ['-t', path.join(result.outputDir, 'VIDEO_TS.zip')]).toString();
    assert.match(r, /No errors detected/);
  });

  test('ISO is read by isoinfo (cdrtools) with the same extents', { skip: which('isoinfo') ? false : 'isoinfo not available' }, () => {
    const iso = path.join(result.outputDir, result.plan.output.isoFileName);
    const listing = execFileSync('isoinfo', ['-l', '-i', iso]).toString();
    const ours = inspectIso(iso);
    for (const f of ours.files) {
      const name = path.basename(f.path);
      assert.match(listing, new RegExp(`\\[\\s*${f.isoSector} 00\\] ${name.replace('.', '\\.')};1`));
    }
  });

  test('ISO is structurally equivalent to the mkisofs -dvd-video reference', { skip: which('mkisofs') ? false : 'mkisofs not available' }, () => {
    const root = path.join(work, 'mkisofs-root');
    fs.mkdirSync(path.join(root, 'AUDIO_TS'), { recursive: true });
    fs.cpSync(result.videoTsDir, path.join(root, 'VIDEO_TS'), { recursive: true });
    const refIso = path.join(work, 'reference.iso');
    execFileSync('mkisofs', ['-dvd-video', '-V', result.plan.output.volumeLabel, '-input-charset', 'utf-8', '-quiet', '-o', refIso, root]);
    const ours = inspectIso(path.join(result.outputDir, result.plan.output.isoFileName));
    const ref = inspectIso(refIso);
    assert.deepEqual(ref.issues, []);
    assert.deepEqual(ours.issues, []);
    const rel = (x: typeof ours) => {
      const base = x.files.find((f) => f.path === 'VIDEO_TS/VIDEO_TS.IFO')?.isoSector ?? 0;
      return Object.fromEntries(x.files.map((f) => [f.path, { size: f.size, offset: (f.isoSector ?? 0) - base, extents: f.udfExtents.length, type: f.udfFileType, perm: f.udfPermissions }]));
    };
    assert.deepEqual(rel(ours), rel(ref)); // same files, sizes, IFO-relative placement, entry types, permissions
    assert.equal(ours.iso9660?.volumeId, ref.iso9660?.volumeId);
    assert.deepEqual(ours.iso9660?.directories.sort(), ref.iso9660?.directories.sort());
    for (const k of ['volumeId', 'logicalVolumeId', 'domain', 'revision', 'accessType', 'blockSize', 'partitionStart'] as const) {
      assert.deepEqual(ours.udf?.[k], ref.udf?.[k], k);
    }
    assert.deepEqual(ours.udf?.descriptors.map((d) => d.tag), ref.udf?.descriptors.map((d) => d.tag));
    assert.deepEqual(ours.udf?.vrs, ref.udf?.vrs);
  });

  test('macOS mounts the ISO as UDF', { skip: process.platform === 'darwin' ? false : 'macOS only' }, () => {
    const ids = Object.fromEntries(result.verification.checks.map((c) => [c.id, c]));
    assert.equal(ids['iso.mount']?.ok, true);
    assert.equal(ids['iso.mount_udf']?.detail, 'udf');
    assert.equal(ids['iso.mount_files']?.ok, true);
    assert.equal(defaultPlatform().name, 'macos');
  });
});

describe('M6: the output folder is the one the user saw', { skip: skipNoTools }, () => {
  const root = tempDir('mp4-to-ifo-m6-');
  const run = () => ({ toolchain: toolchain!, lock: { dir: path.join(root, 'lock') }, tempRoot: path.join(root, 'jobs'), now: new Date('2026-09-24T00:00:00Z') });
  let src = '';
  before(() => {
    src = makeSample(path.join(root, 'clip.mp4'), { seconds: 2 });
    for (const d of ['A', 'B', 'C']) fs.mkdirSync(path.join(root, d));
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));
  const refusal = (reason: string) => (e: ConversionError) => {
    assert.equal(`${e.code} ${e.reason}`, reason === 'PLAN_CHANGED' ? 'INPUT_ERROR PLAN_CHANGED' : `OUTPUT_ERROR ${reason}`);
    return true;
  };

  test('a symlinked folder is resolved when planning: the plan shows, and the files go to, the real folder', async () => {
    const link = path.join(root, 'link-to-A');
    fs.symlinkSync(path.join(root, 'A'), link);
    const { plan } = await analyzeAndPlan(src, { ...run(), outputDirectory: link });
    assert.equal(plan.output.directory, fs.realpathSync(path.join(root, 'A')));
    const r = await convert({ ...run(), input: src, outputDirectory: link, planDigest: planDigest(plan) });
    assert.equal(path.dirname(r.outputDir), plan.output.directory);
    fs.rmSync(r.outputDir, { recursive: true });
  });

  test('symlink re-pointed after the plan was shown -> refused, nothing written anywhere', async () => {
    const link = path.join(root, 'link');
    fs.symlinkSync(path.join(root, 'A'), link);
    const { plan } = await analyzeAndPlan(src, { ...run(), outputDirectory: link });
    fs.unlinkSync(link);
    fs.symlinkSync(path.join(root, 'B'), link);
    await assert.rejects(convert({ ...run(), input: src, outputDirectory: link, planDigest: planDigest(plan) }), refusal('PLAN_CHANGED'));
    assert.deepEqual([fs.readdirSync(path.join(root, 'A')), fs.readdirSync(path.join(root, 'B'))], [[], []]);
  });

  test('folder replaced by another at the same path after the plan was shown -> refused', async () => {
    const dir = path.join(root, 'C');
    const { plan } = await analyzeAndPlan(src, { ...run(), outputDirectory: dir });
    fs.renameSync(dir, path.join(root, 'C-before'));
    fs.mkdirSync(dir);
    await assert.rejects(convert({ ...run(), input: src, outputDirectory: dir, planDigest: planDigest(plan) }), refusal('PLAN_CHANGED'));
    assert.deepEqual([fs.readdirSync(dir), fs.readdirSync(path.join(root, 'C-before'))], [[], []]);
  });

  test('folder replaced while converting -> OUTPUT_CHANGED, nothing written to the new folder', async () => {
    const dir = path.join(root, 'D');
    fs.mkdirSync(dir);
    let swapped = false;
    await assert.rejects(convert({ ...run(), input: src, outputDirectory: dir, onProgress: (e) => {
      if (!swapped && e.phase === 'ENCODING_PASS_2') {
        swapped = true;
        fs.renameSync(dir, path.join(root, 'D-before'));
        fs.mkdirSync(dir);
      }
    } }), refusal('OUTPUT_CHANGED'));
    assert.equal(swapped, true);
    assert.deepEqual([fs.readdirSync(dir), fs.readdirSync(path.join(root, 'D-before'))], [[], []]);
  });

  test('changing the output folder plans again and converts there', async () => {
    const first = await analyzeAndPlan(src, { ...run(), outputDirectory: path.join(root, 'A') });
    const second = await analyzeAndPlan(src, { ...run(), outputDirectory: path.join(root, 'B') });
    assert.notEqual(planDigest(first.plan), planDigest(second.plan));
    const r = await convert({ ...run(), input: src, outputDirectory: path.join(root, 'B'), planDigest: planDigest(second.plan) });
    assert.equal(path.dirname(r.outputDir), fs.realpathSync(path.join(root, 'B')));
    assert.equal(r.verification.passed, true);
  });
});
