// Platform adapter: the only OS-specific pieces (sleep prevention, process identity, image mount).
// Phase 3 ships a macOS adapter; other platforms get a null adapter.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runTool } from './process.ts';

export interface SleepAssertion {
  release(): Promise<void>;
}

export interface MountedImage {
  mountPoint: string;
  fsType: string | null;
  detach(): Promise<void>;
}

export interface PlatformAdapter {
  readonly name: string;
  /** Keep the system awake (display sleep allowed) until released. */
  preventSleep(): Promise<SleepAssertion>;
  /** Start time of a process, used with the PID to detect PID reuse. Null if unknown or not running. */
  processStartTime(pid: number): Promise<string | null>;
  /** Mount a disc image read-only, if the platform supports it. */
  mountImage?(imagePath: string, signal?: AbortSignal): Promise<MountedImage>;
}

export const nullPlatform: PlatformAdapter = {
  name: 'none',
  async preventSleep() {
    return { async release() {} };
  },
  async processStartTime() {
    return null;
  },
};

export function macosPlatform(): PlatformAdapter {
  return {
    name: 'macos',
    async preventSleep() {
      // -i: prevent idle system sleep (display may sleep). -w: exits by itself if this process dies.
      const child = spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
      child.on('error', () => {});
      return {
        async release() {
          if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
        },
      };
    },
    async processStartTime(pid) {
      try {
        const r = await runTool('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { errorCode: 'INTERNAL_ERROR' });
        return r.stdout.trim() || null;
      } catch {
        return null;
      }
    },
    async mountImage(imagePath, signal) {
      const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), 'mp4-to-ifo-mount-'));
      try {
        await runTool('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noverify', '-noautoopen', '-mountpoint', mountPoint, imagePath], {
          errorCode: 'VERIFY_ERROR',
          signal,
        });
      } catch (error) {
        fs.rmSync(mountPoint, { recursive: true, force: true });
        throw error;
      }
      const real = fs.realpathSync(mountPoint);
      const mounts = (await runTool('/sbin/mount', [], { errorCode: 'VERIFY_ERROR' })).stdout;
      const line = mounts.split('\n').find((l) => l.includes(` on ${real} (`));
      return {
        mountPoint,
        fsType: /\((\w+),/.exec(line ?? '')?.[1] ?? null,
        async detach() {
          await runTool('/usr/bin/hdiutil', ['detach', mountPoint, '-quiet'], { errorCode: 'VERIFY_ERROR' }).catch(() =>
            runTool('/usr/bin/hdiutil', ['detach', mountPoint, '-force', '-quiet'], { errorCode: 'VERIFY_ERROR' }).catch(() => {}));
          fs.rmSync(mountPoint, { recursive: true, force: true });
        },
      };
    },
  };
}

export function defaultPlatform(): PlatformAdapter {
  return process.platform === 'darwin' ? macosPlatform() : nullPlatform;
}
