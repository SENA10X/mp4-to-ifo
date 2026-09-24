// The CLI as a user runs it (a child process), against the real core and tools.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { acquireLock, defaultPlatform } from '@mp4-to-ifo/core';
import { LGPL_BIN, makeSample, skipNoTools, tempDir, toolchain } from '../../../core/test/helpers/env.ts';

const MAIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/main.ts');
const work = tempDir('mp4-to-ifo-cli-');
after(() => fs.rmSync(work, { recursive: true, force: true }));
const toolPath = () => [fs.existsSync(LGPL_BIN) ? LGPL_BIN : '', path.dirname(toolchain?.dvdauthor ?? ''), process.env.PATH ?? ''].filter(Boolean).join(':');

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Run the CLI with an isolated TMPDIR (so lock and job folders are per test). */
function cli(args: string[], opts: { tmp?: string; env?: Record<string, string>; group?: boolean; onStdout?: (text: string, child: ReturnType<typeof spawn>) => void } = {}): Promise<Run> {
  const tmp = opts.tmp ?? fs.mkdtempSync(path.join(work, 'tmp-'));
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--conditions=development', MAIN, ...args], {
      env: { ...process.env, PATH: toolPath(), TMPDIR: tmp, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: opts.group ?? false, // own process group, like a terminal job
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      opts.onStdout?.(stdout, child);
    });
    child.stderr.on('data', (d: Buffer) => void (stderr += d.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

describe('CLI end to end', { skip: skipNoTools }, () => {
  test('standard MP4: converts, prints the summary and result, plain output when piped', async () => {
    const src = makeSample(path.join(work, 'opening movie.mp4'), { seconds: 4 });
    const before = sha(src);
    const out = path.join(work, 'out');
    const r = await cli([src, '--output', out, '--yes']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Input\n {2}opening movie\.mp4\n {2}640×360 · 29\.97 fps · 00:04\n {2}Audio: Stereo \(AAC\)/);
    assert.match(r.stdout, /Audio: Stereo → AC-3 Stereo · 256 kbps/);
    assert.match(r.stdout, /Encoding pass 1\/2\.\.\.\n/);
    assert.match(r.stdout, /DVD-Video created and verified\./);
    assert.match(r.stdout, /test it on a DVD player/);
    assert.doesNotMatch(r.stdout + r.stderr, /\r|\x1b/);
    assert.deepEqual(fs.readdirSync(path.join(out, 'opening movie')).sort(), ['VIDEO_TS', 'VIDEO_TS.zip', 'opening movie.iso']);
    assert.equal(sha(src), before);
    // Same name again: numbered by the core
    const again = await cli([src, '--output', out, '--yes']);
    assert.equal(again.code, 0);
    assert.match(again.stdout, /Output\n {2}.*opening movie-2\//);
    assert.ok(fs.existsSync(path.join(out, 'opening movie-2', 'opening movie.iso')));
  });

  test('no audio (with --verbose): silent AC-3 track, tool versions and details', async () => {
    const src = makeSample(path.join(work, 'silent.mp4'), { audio: 'none' });
    const r = await cli([src, '--output', path.join(work, 'out'), '--yes', '--verbose']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Audio: None → Silent AC-3 Stereo/);
    assert.match(r.stdout, /Warning: The MP4 has no audio/);
    assert.match(r.stdout, /Tools\n {2}ffmpeg \S+ \((lgpl|gpl)\)/);
    assert.match(r.stdout, /Frame rate strategy: passthrough-29\.97/);
    assert.match(r.stdout, /Timing: picture -?[\d.]+ ms, sound —, picture vs sound — · field motion [\d.]+/);
  });

  test('5.1 audio is mixed down to stereo', async () => {
    const r = await cli([makeSample(path.join(work, 'surround.mp4'), { audio: '5.1' }), '--output', path.join(work, 'out'), '--yes']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Audio: 5\.1 \(AAC\)[\s\S]*Audio: 5\.1 → AC-3 Stereo/);
    assert.match(r.stdout, /Warning: 5\.1 audio will be mixed down to stereo\./);
  });

  test('unsupported audio layout stops before converting (exit 2)', async () => {
    const r = await cli([makeSample(path.join(work, 'quad.mp4'), { audio: 'quad' }), '--output', path.join(work, 'out'), '--yes']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Error: 4-channel \(quad\) audio is not supported in this version\./);
    assert.ok(!fs.existsSync(path.join(work, 'out', 'quad')));
  });

  test('low bitrate warning is shown; without a TTY or --yes nothing is converted (exit 2)', async () => {
    const long = path.join(work, 'long.mp4');
    execFileSync(toolchain!.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=gray:s=64x36:r=1:d=10800', '-c:v', 'mpeg4', long]);
    const r = await cli([long, '--output', path.join(work, 'out')]);
    assert.equal(r.code, 2);
    assert.match(r.stdout, /03:00:00|3:00:00/);
    assert.match(r.stdout, /Warning: The calculated video bitrate is 3,024 kbps\.\n {2}Video quality may be reduced\./);
    assert.match(r.stderr, /Run with --yes/);
  });

  test('corrupt MP4 (exit 2)', async () => {
    const src = makeSample(path.join(work, 'full.mp4'), { seconds: 6 });
    const bad = path.join(work, 'broken.mp4');
    fs.writeFileSync(bad, fs.readFileSync(src).subarray(0, 40_000));
    const r = await cli([bad, '--yes']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Error: The MP4 file appears to be incomplete or damaged\.|could not be read as an MP4/);
    assert.doesNotMatch(r.stderr, /at .*:\d+:\d+/);
  });

  test('missing input file and missing tools', async () => {
    let r = await cli([path.join(work, 'nope.mp4'), '--yes']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /cannot be read/);
    r = await cli([path.join(work, 'nope.mp4'), '--yes'], { env: { PATH: '/usr/bin:/bin' } });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Error: ffmpeg was not found\.\n\n {2}MP4 to IFO requires ffmpeg, ffprobe, and dvdauthor\./);
  });

  test('another conversion running for this user (exit 1, nothing converted)', async () => {
    const tmp = fs.mkdtempSync(path.join(work, 'tmp-'));
    const lock = await acquireLock({ dir: path.join(tmp, 'mp4-to-ifo'), platform: defaultPlatform() });
    try {
      const r = await cli([makeSample(path.join(work, 'locked.mp4')), '--output', path.join(work, 'out'), '--yes'], { tmp });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /Another MP4 to IFO conversion is already running for this user\./);
      assert.ok(!fs.existsSync(path.join(work, 'out', 'locked')));
    } finally {
      lock.release();
    }
  });

  const cases = [
    { name: 'SIGINT', sig: 'SIGINT', group: false },
    { name: 'SIGTERM', sig: 'SIGTERM', group: false },
    // Ctrl+C in a terminal signals the whole foreground process group, ffmpeg included.
    { name: 'Ctrl+C (SIGINT to the process group)', sig: 'SIGINT', group: true },
  ] as const;
  for (const { name, sig, group } of cases) {
    test(`${name} while encoding: cancels, cleans up, releases the lock (exit 4)`, async () => {
      const tmp = fs.mkdtempSync(path.join(work, 'tmp-'));
      const src = makeSample(path.join(work, `cancel-${sig}-${group}.mp4`), { seconds: 30, size: '1280x720' });
      const out = path.join(work, `out-${sig}-${group}`);
      let sent = false;
      const r = await cli([src, '--output', out, '--yes'], {
        tmp,
        group,
        onStdout: (text, child) => {
          if (!sent && /Encoding pass 1\/2\.\.\./.test(text)) {
            sent = true;
            setTimeout(() => (group ? process.kill(-(child.pid ?? 0), sig) : child.kill(sig)), 500);
          }
        },
      });
      assert.equal(r.code, 4, r.stderr);
      assert.match(r.stderr, /Cancelling\.\.\./);
      assert.match(r.stderr, /Cancelled\. No output was kept\./);
      assert.deepEqual(fs.existsSync(out) ? fs.readdirSync(out) : [], []);
      assert.deepEqual(fs.readdirSync(path.join(tmp, 'mp4-to-ifo', 'jobs')), []);
      assert.equal(fs.existsSync(path.join(tmp, 'mp4-to-ifo', 'conversion.lock')), false);
      assert.ok(!execFileSync('ps', ['-axo', 'command']).toString().includes(tmp), 'no child process left');
    });
  }
});
