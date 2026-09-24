// The desktop engine exactly as the app runs it: bundled node + engine.js + bundled ffmpeg, ffprobe and
// dvdauthor, with an empty environment and PATH=/usr/bin:/bin (no Homebrew). Requires the toolchain
// (npm run build:toolchain) and the engine (npm run build:engine).

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(DESKTOP, 'src-tauri/binaries');
const NODE = path.join(BIN, 'node-aarch64-apple-darwin');
const ENGINE = path.join(DESKTOP, 'src-tauri/engine/engine.js');
const ready = fs.existsSync(NODE) && fs.existsSync(ENGINE) && ['ffmpeg', 'ffprobe', 'dvdauthor'].every((t) => fs.existsSync(path.join(BIN, `${t}-aarch64-apple-darwin`)));
const skip = ready ? false : 'bundled toolchain or engine not built';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mp4-to-ifo-engine-'));
const tools = path.join(work, 'MacOS'); // like Contents/MacOS: sidecars without the target suffix
after(() => fs.rmSync(work, { recursive: true, force: true }));

// Engine messages are checked field by field in the tests.
type Message = { type: string } & Record<string, any>;

/** Environment the app gives the engine: nothing inherited, no Homebrew on PATH. */
const env = (tmp: string) => ({ HOME: os.homedir(), PATH: '/usr/bin:/bin', TMPDIR: tmp, LANG: 'en_US.UTF-8' });

function analyze(input: string, output: string, toolDir = tools): Message {
  const tmp = fs.mkdtempSync(path.join(work, 'tmp-'));
  const r = spawnSync(NODE, [ENGINE, 'analyze', input, '--tools', toolDir, '--output', output, '--app-version', '0.1.0'], { env: env(tmp), encoding: 'utf8' });
  return JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}') as Message;
}

interface ConvertRun {
  messages: Message[];
  code: number | null;
  ffmpegPaths: string[];
  tmp: string;
}

/** Start a conversion; `control` can cancel or close stdin once progress arrives. */
function convert(input: string, output: string, control?: (child: ReturnType<typeof spawn>, m: Message) => void): Promise<ConvertRun> {
  fs.mkdirSync(output, { recursive: true });
  const plan = analyze(input, output);
  assert.equal(plan.type, 'plan', JSON.stringify(plan));
  return runJob(JSON.stringify({ input, outputDirectory: output, planDigest: plan.planDigest }), control);
}

/** Send one job line exactly as given (the app, or a modified UI) to a convert engine. */
function runJob(line: string, control?: (child: ReturnType<typeof spawn>, m: Message) => void): Promise<ConvertRun> {
  const tmp = fs.mkdtempSync(path.join(work, 'tmp-'));
  return new Promise((resolve) => {
    const child = spawn(NODE, [ENGINE, 'convert', '--tools', tools, '--app-version', '0.1.0'], { env: env(tmp), stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.write(`${line}\n`);
    const messages: Message[] = [];
    const ffmpegPaths = new Set<string>();
    let buffer = '';
    child.stdout.on('data', (d: Buffer) => {
      buffer += d.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const m = JSON.parse(line) as Message;
        messages.push(m);
        if (m.type === 'progress') {
          for (const cmd of execFileSync('ps', ['-axo', 'command']).toString().split('\n')) {
            if (cmd.includes(tmp) && / -i /.test(cmd)) ffmpegPaths.add(cmd.split(' ')[0] ?? '');
          }
          control?.(child, m);
        }
      }
    });
    child.on('close', (code) => resolve({ messages, code, ffmpegPaths: [...ffmpegPaths], tmp }));
  });
}

const noProcessesFor = (tmp: string) => !execFileSync('ps', ['-axo', 'command']).toString().includes(tmp);

describe('desktop engine with the bundled toolchain only', { skip }, () => {
  let samples: typeof import('../../../../packages/core/test/helpers/env.ts');
  before(async () => {
    fs.mkdirSync(tools);
    for (const t of ['ffmpeg', 'ffprobe', 'dvdauthor']) fs.copyFileSync(path.join(BIN, `${t}-aarch64-apple-darwin`), path.join(tools, t));
    for (const t of ['ffmpeg', 'ffprobe', 'dvdauthor']) fs.chmodSync(path.join(tools, t), 0o755);
    samples = await import('../../../../packages/core/test/helpers/env.ts');
  });

  test('bundled ffmpeg is LGPL and runs on its own', () => {
    const license = execFileSync(path.join(tools, 'ffmpeg'), ['-hide_banner', '-L'], { env: { PATH: '/usr/bin:/bin' } }).toString().replace(/\s+/g, ' ');
    assert.match(license, /GNU Lesser General Public License/);
    assert.doesNotMatch(execFileSync(path.join(tools, 'ffmpeg'), ['-hide_banner', '-version']).toString(), /--enable-(gpl|nonfree)/);
  });

  test('analyze -> plan, convert -> VIDEO_TS, ZIP and ISO, using only the bundled tools', async () => {
    const input = samples.makeSample(path.join(work, 'オープニング movie.mp4'), { seconds: 4 });
    const out = path.join(work, 'out');
    fs.mkdirSync(out);
    const plan = analyze(input, out);
    assert.match(plan.planDigest, /^[0-9a-f]{64}$/);
    assert.equal(plan.type, 'plan');
    assert.equal((plan.analysis as { fileName: string }).fileName, 'オープニング movie.mp4');
    assert.equal(plan.outputFolder, path.join(fs.realpathSync(out), 'オープニング movie')); // the real folder is shown

    const run = await convert(input, out);
    assert.equal(run.code, 0, JSON.stringify(run.messages.at(-1)));
    const done = run.messages.at(-1) as { type: string; result: { outputDir: string; isoFileName: string } };
    assert.equal(done.type, 'done');
    assert.deepEqual(fs.readdirSync(done.result.outputDir).sort(), ['VIDEO_TS', 'VIDEO_TS.zip', 'オープニング movie.iso'].sort());
    const phases = [...new Set(run.messages.filter((m) => m.type === 'progress').map((m) => (m.event as { phase: string }).phase))];
    assert.deepEqual(phases, ['ANALYZING', 'PREFLIGHT', 'ENCODING_PASS_1', 'ENCODING_PASS_2', 'AUTHORING', 'CREATING_ZIP', 'CREATING_ISO', 'VERIFYING', 'FINALIZING', 'COMPLETED']);
    assert.ok(run.ffmpegPaths.length > 0, 'saw ffmpeg running');
    for (const p of run.ffmpegPaths) assert.ok(p.startsWith(tools), `tool from ${p}`);
    assert.ok(noProcessesFor(run.tmp));
  });

  test('"cancel" stops the conversion, removes partial output and leaves no process', async () => {
    const input = samples.makeSample(path.join(work, 'cancel.mp4'), { seconds: 30, size: '1280x720' });
    const out = path.join(work, 'out-cancel');
    let sent = false;
    const run = await convert(input, out, (child, m) => {
      if (!sent && (m.event as { phase: string }).phase === 'ENCODING_PASS_1') {
        sent = true;
        child.stdin?.write('cancel\n');
      }
    });
    assert.equal(run.code, 4);
    assert.equal(run.messages.at(-1)?.error.code, 'CANCELLED');
    assert.deepEqual(fs.existsSync(out) ? fs.readdirSync(out) : [], []);
    assert.deepEqual(fs.readdirSync(path.join(run.tmp, 'mp4-to-ifo', 'jobs')), []);
    assert.equal(fs.existsSync(path.join(run.tmp, 'mp4-to-ifo', 'conversion.lock')), false);
    assert.ok(noProcessesFor(run.tmp));
  });

  test('the app going away (stdin closed) aborts and stops ffmpeg', async () => {
    const input = path.join(work, 'cancel.mp4');
    const out = path.join(work, 'out-orphan');
    let closed = false;
    const run = await convert(input, out, (child, m) => {
      if (!closed && (m.event as { phase: string }).phase === 'ENCODING_PASS_1') {
        closed = true;
        child.stdin?.end();
      }
    });
    assert.equal(run.code, 4);
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(noProcessesFor(run.tmp), 'no ffmpeg left');
    assert.deepEqual(fs.existsSync(out) ? fs.readdirSync(out) : [], []);
  });

  test('the app killed (stdin and stdout gone) still cleans up and stops ffmpeg', async () => {
    const input = samples.makeSample(path.join(work, 'killed.mp4'), { seconds: 30, size: '1280x720' });
    const out = path.join(work, 'out-killed');
    let killed = false;
    const run = await convert(input, out, (child, m) => {
      if (!killed && (m.event as { phase: string }).phase === 'ENCODING_PASS_1') {
        killed = true;
        child.stdout?.destroy(); // the next progress line gets EPIPE
        child.stdin?.destroy();
      }
    });
    assert.equal(run.code, 4);
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(noProcessesFor(run.tmp), 'no ffmpeg left');
    assert.deepEqual(fs.existsSync(out) ? fs.readdirSync(out) : [], []);
    assert.deepEqual(fs.readdirSync(path.join(run.tmp, 'mp4-to-ifo', 'jobs')), []);
    assert.equal(fs.existsSync(path.join(run.tmp, 'mp4-to-ifo', 'conversion.lock')), false);
  });

  test('errors carry a code and a redacted report', () => {
    const src = samples.makeSample(path.join(work, '山田家 full.mp4'), { seconds: 6 });
    const broken = path.join(work, '山田家 broken.mp4');
    fs.writeFileSync(broken, fs.readFileSync(src).subarray(0, 40_000));
    const e = analyze(broken, path.join(work, 'out')) as { type: string; error: { code: string; reason: string; report: object } };
    assert.equal(e.type, 'error');
    assert.equal(e.error.code, 'INPUT_ERROR');
    const report = JSON.stringify(e.error.report);
    assert.ok(!report.includes('山田家') && !report.includes(work) && !report.includes(os.homedir()), report);

    const quad = analyze(samples.makeSample(path.join(work, 'quad.mp4'), { audio: 'quad' }), path.join(work, 'out'));
    assert.deepEqual(quad.plan.errors.map((i: { code: string }) => i.code), ['UNSUPPORTED_AUDIO_LAYOUT']);
  });

  test('a missing bundled tool is a clear preflight error', () => {
    const partial = path.join(work, 'partial');
    fs.mkdirSync(partial);
    fs.copyFileSync(path.join(tools, 'ffprobe'), path.join(partial, 'ffprobe'));
    const e = analyze(path.join(work, 'cancel.mp4'), path.join(work, 'out'), partial);
    assert.equal(e.error.code, 'PREFLIGHT_ERROR');
    assert.equal(e.error.reason, 'TOOL_MISSING');
  });

  describe('M3: the UI chooses the input and the output folder, nothing else', () => {
    let input = '';
    let out = '';
    let plan: Message;
    const leftovers = () => [out, work].flatMap((d) => fs.readdirSync(d)).filter((n) => /\.iso$|^x$|^\.mp4-to-ifo-/.test(n));
    before(() => {
      input = samples.makeSample(path.join(work, 'boundary.mp4'), { seconds: 2 });
      out = path.join(work, 'out-boundary');
      fs.mkdirSync(out);
      plan = analyze(input, out);
      assert.equal(plan.type, 'plan');
    });
    const refused = async (job: unknown, reason: string) => {
      const run = await runJob(typeof job === 'string' ? job : JSON.stringify(job));
      const last = run.messages.at(-1);
      assert.equal(last?.type, 'error', JSON.stringify(last));
      assert.equal(last?.error.code, 'INPUT_ERROR');
      assert.equal(last?.error.reason, reason, JSON.stringify(last?.error));
      assert.equal(run.code, 2);
      assert.equal(run.messages.some((m) => m.type === 'progress' && m.event.phase !== 'ANALYZING'), false, 'no conversion work');
      assert.deepEqual(fs.readdirSync(out), []);
      assert.deepEqual(leftovers(), []);
    };
    const forged = (edit: (p: any) => void) => {
      const p = structuredClone(plan.plan);
      edit(p);
      return p;
    };
    const ok = () => ({ input, outputDirectory: out, planDigest: plan.planDigest as string });

    test('forged bitrate, ffmpeg filter or ISO names in a job are refused', async () => {
      await refused({ ...ok(), plan: forged((p) => { p.video.bitrateKbps = 1; }) }, 'INVALID_JOB');
      await refused({ ...ok(), plan: forged((p) => { p.video.filter = 'movie=/etc/passwd'; }) }, 'INVALID_JOB');
      await refused({ ...ok(), plan: forged((p) => { p.output.isoFileName = '../../x.iso'; }) }, 'INVALID_JOB');
      await refused({ ...ok(), plan: forged((p) => { p.output.isoFileName = path.join(work, 'x.iso'); }) }, 'INVALID_JOB');
      await refused({ ...ok(), videoBitrateKbps: 1 }, 'INVALID_JOB');
      await refused({ input, outputDirectory: out, plan: plan.plan }, 'INVALID_JOB'); // the Phase 5 protocol
      await refused('not json', 'INVALID_JOB');
    });

    test('the digest of a forged plan does not match the plan the core makes', async () => {
      const { createHash } = await import('node:crypto');
      const digest = (p: unknown) => createHash('sha256').update(JSON.stringify(p)).digest('hex');
      await refused({ ...ok(), planDigest: digest(forged((p) => { p.video.bitrateKbps = 1; })) }, 'PLAN_CHANGED');
      await refused({ ...ok(), planDigest: digest(forged((p) => { p.output.isoFileName = '../../x.iso'; })) }, 'PLAN_CHANGED');
      await refused({ ...ok(), planDigest: 'f'.repeat(64) }, 'PLAN_CHANGED');
      await refused({ ...ok(), planDigest: 'not-a-digest' }, 'INVALID_JOB');
    });

    test('output folder: must be the existing, absolute folder that was planned', async () => {
      const other = path.join(work, 'out-other');
      fs.mkdirSync(other, { recursive: true });
      await refused({ ...ok(), outputDirectory: 'out-boundary' }, 'INVALID_JOB');
      await refused({ ...ok(), outputDirectory: `${out}/../out-boundary` }, 'INVALID_JOB');
      await refused({ ...ok(), outputDirectory: path.join(work, 'missing') }, 'INVALID_JOB');
      await refused({ ...ok(), outputDirectory: input }, 'INVALID_JOB');
      await refused({ ...ok(), outputDirectory: other }, 'PLAN_CHANGED');
      assert.deepEqual(fs.readdirSync(other), []);
      assert.equal(fs.existsSync(path.join(work, 'missing')), false);
      assert.equal(analyze(input, 'relative/dir').error?.reason, 'INVALID_JOB');
    });

    test('input changed after the plan was shown (content, or only its time stamp) is refused', async () => {
      const changing = samples.makeSample(path.join(work, 'changing.mp4'), { seconds: 2 });
      const shown = analyze(changing, out);
      samples.makeSample(changing, { seconds: 3 });
      await refused({ input: changing, outputDirectory: out, planDigest: shown.planDigest }, 'PLAN_CHANGED');
      const again = analyze(changing, out);
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(changing, later, later);
      await refused({ input: changing, outputDirectory: out, planDigest: again.planDigest }, 'PLAN_CHANGED');
      await refused({ ...ok(), input: 'boundary.mp4' }, 'INVALID_JOB');
    });

    test('M6: output folder re-pointed (symlink) or replaced after the plan was shown is refused', async () => {
      const a = path.join(work, 'm6-A');
      const b = path.join(work, 'm6-B');
      const link = path.join(work, 'm6-link');
      fs.mkdirSync(a);
      fs.mkdirSync(b);
      fs.symlinkSync(a, link);
      const shown = analyze(input, link);
      assert.equal(shown.plan.output.directory, fs.realpathSync(a), 'the plan shows the real folder');
      fs.unlinkSync(link);
      fs.symlinkSync(b, link);
      // The link now points elsewhere: sent as the link, the job is refused.
      await refused({ input, outputDirectory: link, planDigest: shown.planDigest }, 'PLAN_CHANGED');
      // The UI sends the folder it showed (the real path): the conversion stays pinned there.
      const pinned = await runJob(JSON.stringify({ input, outputDirectory: shown.plan.output.directory, planDigest: shown.planDigest }));
      assert.equal(pinned.code, 0, JSON.stringify(pinned.messages.at(-1)));
      assert.deepEqual([fs.readdirSync(a), fs.readdirSync(b)], [['boundary'], []]);
      // The shown folder replaced by another folder at the same path: refused.
      const shownA = analyze(input, a);
      fs.renameSync(a, `${a}-before`);
      fs.mkdirSync(a);
      await refused({ input, outputDirectory: shownA.plan.output.directory, planDigest: shownA.planDigest }, 'PLAN_CHANGED');
      assert.deepEqual([fs.readdirSync(a), fs.readdirSync(`${a}-before`), fs.readdirSync(b)], [[], ['boundary'], []]);
    });

    test('changing the output folder plans again; converting uses the new folder', async () => {
      const other = path.join(work, 'out-replanned');
      fs.mkdirSync(other);
      const replanned = analyze(input, other);
      assert.equal(replanned.plan.output.directory, fs.realpathSync(other));
      assert.notEqual(replanned.planDigest, plan.planDigest);
      const run = await runJob(JSON.stringify({ input, outputDirectory: replanned.plan.output.directory, planDigest: replanned.planDigest }));
      assert.equal(run.code, 0, JSON.stringify(run.messages.at(-1)));
      assert.deepEqual(fs.readdirSync(other), ['boundary']);
      assert.deepEqual(fs.readdirSync(path.join(other, 'boundary')).sort(), ['VIDEO_TS', 'VIDEO_TS.zip', 'boundary.iso']);
      assert.deepEqual(fs.readdirSync(out), []);
    });
  });
});
