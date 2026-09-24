// Single conversion per macOS user (v1): GUI and CLI processes of the same user exclude each other.
// The default directory is under os.tmpdir(), which is per user on macOS; `dir` can point elsewhere.
// A lock file created with O_EXCL holds the owner's PID, its process start time and a random token.
// A lock is stale when the PID is gone, when the PID now belongs to a different process (start time
// differs), or, if the start time cannot be read, when the owner stopped refreshing it. Takeover
// renames the stale file first so only one contender wins.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConversionError } from './errors.ts';
import type { PlatformAdapter } from './platform.ts';

export interface LockOwner {
  token: string;
  pid: number;
  hostname: string;
  processStart: string | null;
  createdAt: string;
}

export interface ConversionLock {
  readonly path: string;
  readonly owner: LockOwner;
  release(): void;
}

export interface LockOptions {
  /** Directory for the lock file. Default: <os.tmpdir()>/mp4-to-ifo. */
  dir?: string;
  platform: PlatformAdapter;
  /** Heartbeat interval; a lock whose owner cannot be identified is stale after 5x this. */
  heartbeatMs?: number;
}

const LOCK_NAME = 'conversion.lock';

export function defaultLockDir(): string {
  return path.join(os.tmpdir(), 'mp4-to-ifo');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readOwner(file: string): LockOwner | null {
  try {
    const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as LockOwner;
    return typeof owner.token === 'string' && typeof owner.pid === 'number' ? owner : null;
  } catch {
    return null;
  }
}

export async function isStale(file: string, owner: LockOwner | null, platform: PlatformAdapter, heartbeatMs: number): Promise<boolean> {
  let ageMs = Infinity;
  try {
    ageMs = Date.now() - fs.statSync(file).mtimeMs;
  } catch {
    return true;
  }
  if (!owner) return ageMs > 5 * heartbeatMs; // unreadable (e.g. half-written): give the writer time
  if (owner.hostname !== os.hostname()) return ageMs > 5 * heartbeatMs;
  if (!pidAlive(owner.pid)) return true;
  const start = await platform.processStartTime(owner.pid);
  if (start !== null && owner.processStart !== null) return start !== owner.processStart; // PID reused
  return ageMs > 5 * heartbeatMs;
}

export async function acquireLock(options: LockOptions): Promise<ConversionLock> {
  const dir = options.dir ?? defaultLockDir();
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LOCK_NAME);
  const owner: LockOwner = {
    token: crypto.randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    processStart: await options.platform.processStartTime(process.pid),
    createdAt: new Date().toISOString(),
  };

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o644);
      fs.writeSync(fd, JSON.stringify(owner));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      const timer = setInterval(() => {
        try {
          const now = new Date();
          fs.utimesSync(file, now, now);
        } catch {
          // lock removed externally; release() handles it
        }
      }, heartbeatMs);
      timer.unref();
      let released = false;
      return {
        path: file,
        owner,
        release() {
          if (released) return;
          released = true;
          clearInterval(timer);
          if (readOwner(file)?.token === owner.token) fs.rmSync(file, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new ConversionError('PREFLIGHT_ERROR', 'Conversion lock could not be created', { reason: 'LOCK_IO', cause: error });
      }
    }
    const existing = readOwner(file);
    if (!(await isStale(file, existing, options.platform, heartbeatMs))) {
      throw new ConversionError('PREFLIGHT_ERROR', 'Another conversion is running', {
        reason: 'LOCKED',
        detail: existing ? `pid ${existing.pid} since ${existing.createdAt}` : 'lock file present',
      });
    }
    // Take over: move the stale file aside, confirm it is the one we judged, then retry O_EXCL.
    const aside = `${file}.stale-${crypto.randomUUID()}`;
    try {
      fs.renameSync(file, aside);
    } catch {
      continue; // someone else moved it; retry
    }
    const moved = readOwner(aside);
    if (existing && moved && moved.token !== existing.token) {
      // A new owner appeared between our check and the rename: put it back.
      try {
        fs.linkSync(aside, file);
      } catch {
        // file recreated meanwhile; the new owner keeps it
      }
    }
    fs.rmSync(aside, { force: true });
  }
  throw new ConversionError('PREFLIGHT_ERROR', 'Conversion lock is contended', { reason: 'LOCKED' });
}
