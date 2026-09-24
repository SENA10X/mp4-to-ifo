import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { acquireLock } from '../../src/lock.ts';
import { defaultPlatform, type PlatformAdapter } from '../../src/platform.ts';

const platform = defaultPlatform();
const created: string[] = [];
const dir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-'));
  created.push(d);
  return d;
};
after(() => created.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const lockFile = (d: string) => path.join(d, 'conversion.lock');
const writeLock = (d: string, owner: object) => fs.writeFileSync(lockFile(d), JSON.stringify({ token: 'other', hostname: os.hostname(), createdAt: 'x', ...owner }));

test('second acquire is refused; release frees the lock', async () => {
  const d = dir();
  const a = await acquireLock({ dir: d, platform });
  await assert.rejects(acquireLock({ dir: d, platform }), (e: Error & { reason?: string }) => e.reason === 'LOCKED');
  a.release();
  assert.equal(fs.existsSync(lockFile(d)), false);
  const b = await acquireLock({ dir: d, platform });
  b.release();
});

test('lock of a dead process is recovered', async () => {
  const d = dir();
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => child.on('exit', r));
  writeLock(d, { pid: child.pid, processStart: 'whatever' });
  const lock = await acquireLock({ dir: d, platform });
  assert.equal(lock.owner.pid, process.pid);
  lock.release();
});

test('PID reuse (alive PID, different start time) is treated as stale', async (t) => {
  const start = await platform.processStartTime(process.ppid);
  if (start === null) return t.skip('process start time unavailable on this platform');
  const d = dir();
  writeLock(d, { pid: process.ppid, processStart: 'Thu Jan  1 00:00:00 1970' });
  const lock = await acquireLock({ dir: d, platform });
  lock.release();
});

test('alive owner with matching start time keeps the lock', async (t) => {
  const start = await platform.processStartTime(process.ppid);
  if (start === null) return t.skip('process start time unavailable on this platform');
  const d = dir();
  writeLock(d, { pid: process.ppid, processStart: start });
  await assert.rejects(acquireLock({ dir: d, platform }), (e: Error & { reason?: string }) => e.reason === 'LOCKED');
  assert.equal(JSON.parse(fs.readFileSync(lockFile(d), 'utf8')).token, 'other'); // untouched
});

test('without process identity, a lock is stale only after missed heartbeats', async () => {
  const blind: PlatformAdapter = { ...platform, processStartTime: async () => null };
  const d = dir();
  writeLock(d, { pid: process.ppid, processStart: null });
  await assert.rejects(acquireLock({ dir: d, platform: blind, heartbeatMs: 60_000 }));
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(lockFile(d), old, old);
  const lock = await acquireLock({ dir: d, platform: blind, heartbeatMs: 60_000 });
  lock.release();
});

test('release never removes a lock owned by someone else', async () => {
  const d = dir();
  const lock = await acquireLock({ dir: d, platform });
  writeLock(d, { pid: process.ppid, processStart: null }); // replaced externally
  lock.release();
  assert.equal(fs.existsSync(lockFile(d)), true);
});
