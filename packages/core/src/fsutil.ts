// File helpers: hashing, source fingerprints, free space, cross-volume moves.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { throwIfAborted } from './errors.ts';

export async function sha256File(file: string, signal?: AbortSignal, range?: { start: number; length: number }): Promise<string> {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(8 * 1024 * 1024);
    let position = range?.start ?? 0;
    let remaining = range?.length ?? Infinity;
    while (remaining > 0) {
      throwIfAborted(signal);
      const n = fs.readSync(fd, buf, 0, Math.min(buf.length, remaining), position);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
      position += n;
      remaining -= n;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export interface SourceFingerprint {
  size: number;
  mtimeMs: number;
  ino: number;
  /** sha256 of the first and last 4 MiB: cheap evidence the content was not rewritten. */
  edgesSha256: string;
}

export async function fingerprint(file: string, signal?: AbortSignal): Promise<SourceFingerprint> {
  const st = fs.statSync(file);
  const edge = 4 * 1024 * 1024;
  const head = await sha256File(file, signal, { start: 0, length: edge });
  const tail = await sha256File(file, signal, { start: Math.max(0, st.size - edge), length: edge });
  return { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, edgesSha256: `${head}:${tail}` };
}

export function freeBytes(dir: string): number {
  const s = fs.statfsSync(dir);
  return s.bavail * s.bsize;
}

export function sameVolume(a: string, b: string): boolean {
  return fs.statSync(a).dev === fs.statSync(b).dev;
}

/** Rename, or copy + remove when crossing volumes. */
export function moveDir(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

export function listFiles(dir: string): string[] {
  return fs.readdirSync(dir).filter((n) => !n.startsWith('.') && fs.statSync(path.join(dir, n)).isFile()).sort();
}

/**
 * Where an output folder really is: symlinks resolved (a folder that does not exist yet is resolved
 * through its nearest existing parent), and its device:inode, or null while it does not exist.
 */
export function resolveDirectory(dir: string): { path: string; id: string | null } {
  const absolute = path.resolve(dir);
  let existing = absolute;
  const rest: string[] = [];
  while (!fs.existsSync(existing) && path.dirname(existing) !== existing) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  const real = path.join(fs.realpathSync(existing), ...rest);
  return { path: real, id: directoryId(real) };
}

/** device:inode of a directory (following nothing: the path itself must be the directory), or null. */
export function directoryId(dir: string): string | null {
  try {
    const st = fs.lstatSync(dir);
    return st.isDirectory() ? `${st.dev}:${st.ino}` : null;
  } catch {
    return null;
  }
}
