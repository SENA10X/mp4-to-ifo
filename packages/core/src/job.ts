// Conversion job: lock, analyze, plan, preflight, encode, author, ZIP, ISO, verify, finalize, cleanup.
// Nothing is written into the final output folder until verification passes; the staging folder is
// then renamed into place in one step.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeInput, type InputAnalysis } from './analyze.ts';
import { author } from './author.ts';
import { encode } from './encode.ts';
import { ConversionError, cancelledError, throwIfAborted, toConversionError } from './errors.ts';
import { directoryId, fingerprint, freeBytes, moveDir, resolveDirectory, sameVolume } from './fsutil.ts';
import { writeDvdIso } from './iso/writer.ts';
import { acquireLock, type ConversionLock } from './lock.ts';
import { noopLog, type LogSink } from './log.ts';
import { numberedName, safeChildPath } from './naming.ts';
import { defaultPlatform, type PlatformAdapter, type SleepAssertion } from './platform.ts';
import { planConversion, planDigest, type ConversionPlan, type PlanOptions } from './plan.ts';
import { inspectToolchain, type Toolchain, type ToolchainReport } from './toolchain.ts';
import { verifyOutput, type VerificationReport } from './verify/index.ts';
import { writeZip } from './zip.ts';

export type ConversionPhase =
  | 'ANALYZING'
  | 'PREFLIGHT'
  | 'ENCODING_PASS_1'
  | 'ENCODING_PASS_2'
  | 'AUTHORING'
  | 'CREATING_ZIP'
  | 'CREATING_ISO'
  | 'VERIFYING'
  | 'FINALIZING'
  | 'COMPLETED';

export interface ProgressEvent {
  phase: ConversionPhase;
  /** 0–1 within the phase, when known. */
  phaseProgress: number | null;
  /** 0–1 for the whole job. */
  overallProgress: number;
  /** Encoding only: processed media time and total, seconds. */
  mediaTime?: number;
  mediaDuration?: number;
}

const WEIGHTS: Record<ConversionPhase, number> = {
  ANALYZING: 2, PREFLIGHT: 1, ENCODING_PASS_1: 30, ENCODING_PASS_2: 35, AUTHORING: 2,
  CREATING_ZIP: 4, CREATING_ISO: 4, VERIFYING: 20, FINALIZING: 2, COMPLETED: 0,
};
const ORDER = Object.keys(WEIGHTS) as ConversionPhase[];
const TOTAL = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);

export interface ConvertOptions extends PlanOptions {
  input: string;
  toolchain: Toolchain;
  /**
   * planDigest() of the plan the user accepted. The core always converts with the plan it makes from
   * its own analysis; when that differs from the accepted one (the input or output folder changed, or
   * the caller sent a different plan), nothing is converted (INPUT_ERROR, PLAN_CHANGED).
   */
  planDigest?: string;
  platform?: PlatformAdapter;
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
  log?: LogSink;
  /** Root for job working folders. Default: <os.tmpdir()>/mp4-to-ifo/jobs. */
  tempRoot?: string;
  /** Lock settings, or false to skip locking (tests only). */
  lock?: { dir?: string } | false;
  /** Refuse ffmpeg builds that are not LGPL (production builds set this). */
  requireLgpl?: boolean;
  /** Timestamp recorded in ZIP/ISO metadata. Default: now. */
  now?: Date;
}

export interface ConversionResult {
  outputDir: string;
  videoTsDir: string;
  zipPath: string;
  isoPath: string;
  plan: ConversionPlan;
  toolchain: ToolchainReport;
  audio: { peakDbfs: number | null; gainDb: number };
  verification: VerificationReport;
  timingsMs: Partial<Record<ConversionPhase, number>>;
}

export function defaultTempRoot(): string {
  return path.join(os.tmpdir(), 'mp4-to-ifo', 'jobs');
}

const STAGING_PREFIX = '.mp4-to-ifo-';
const STAGING_SUFFIX = '.partial';

export async function analyzeAndPlan(input: string, options: { toolchain: Toolchain; signal?: AbortSignal; log?: LogSink } & PlanOptions): Promise<{ analysis: InputAnalysis; plan: ConversionPlan }> {
  const analysis = await analyzeInput(input, options.toolchain, options);
  return { analysis, plan: planFor(analysis, options) };
}

/** The plan with the output folder resolved to where it really is, and that folder's identity. */
function planFor(analysis: InputAnalysis, options: PlanOptions): ConversionPlan {
  const output = resolveDirectory(options.outputDirectory ?? path.dirname(analysis.path));
  return planConversion(analysis, { ...options, outputDirectory: output.path }, output.id);
}

/**
 * The output folder must still be the one planned (or, if it did not exist then, the one created at
 * preflight): same real path, same device:inode, and the staging folder inside it. Guards against the
 * folder being replaced or re-pointed while converting.
 */
function assertOutputDirectory(outputDir: string, pinned: string | null, staging?: string): void {
  const same = resolveDirectory(outputDir).path === outputDir && directoryId(outputDir) === pinned &&
    (!staging || directoryId(path.join(staging, '..')) === pinned);
  if (!pinned || !same) throw new ConversionError('OUTPUT_ERROR', 'The output folder was moved or replaced', { reason: 'OUTPUT_CHANGED' });
}

export async function convert(options: ConvertOptions): Promise<ConversionResult> {
  const { signal, toolchain } = options;
  const log = options.log ?? noopLog;
  const platform = options.platform ?? defaultPlatform();
  const date = options.now ?? new Date();
  const timings: Partial<Record<ConversionPhase, number>> = {};
  let current: ConversionPhase = 'ANALYZING';
  let phaseStart = Date.now();
  const enter = (phase: ConversionPhase) => {
    timings[current] = (timings[current] ?? 0) + Date.now() - phaseStart;
    current = phase;
    phaseStart = Date.now();
    emit(phase, phase === 'COMPLETED' ? 1 : 0);
    log({ level: 'info', event: 'phase', message: phase });
  };
  const emit = (phase: ConversionPhase, fraction: number | null, media?: { time: number; duration: number }) => {
    const before = ORDER.slice(0, ORDER.indexOf(phase)).reduce((s, p) => s + WEIGHTS[p], 0);
    const overall = phase === 'COMPLETED' ? 1 : (before + WEIGHTS[phase] * (fraction ?? 0)) / TOTAL;
    options.onProgress?.({
      phase,
      phaseProgress: fraction,
      overallProgress: Math.min(1, overall),
      ...(media ? { mediaTime: media.time, mediaDuration: media.duration } : {}),
    });
  };

  let lock: ConversionLock | null = null;
  let sleep: SleepAssertion | null = null;
  let jobDir: string | null = null;
  let staging: string | null = null;
  try {
    throwIfAborted(signal);
    if (options.lock !== false) lock = await acquireLock({ dir: options.lock?.dir, platform });
    emit('ANALYZING', 0);

    const analysis = await analyzeInput(options.input, toolchain, { signal, log });
    const plan = planFor(analysis, options);
    if (options.planDigest !== undefined && options.planDigest !== planDigest(plan)) {
      throw new ConversionError('INPUT_ERROR', 'The input or output folder changed after planning', { reason: 'PLAN_CHANGED' });
    }
    if (plan.errors.length) {
      throw new ConversionError('INPUT_ERROR', 'Input cannot be converted', { reason: plan.errors.map((e) => e.code).join(','), detail: JSON.stringify(plan.errors) });
    }

    enter('PREFLIGHT');
    const report = await inspectToolchain(toolchain, signal);
    if (report.missing.length) throw new ConversionError('PREFLIGHT_ERROR', 'ffmpeg lacks required features', { reason: 'TOOL_FEATURES', detail: report.missing.join(' ') });
    if (plan.video.hdr.strategy === 'tonemap-experimental' && report.missingExperimental.length) {
      throw new ConversionError('PREFLIGHT_ERROR', 'ffmpeg lacks HDR tone mapping filters', { reason: 'TOOL_FEATURES', detail: report.missingExperimental.join(' ') });
    }
    if (options.requireLgpl && report.ffmpeg.license !== 'lgpl') {
      throw new ConversionError('PREFLIGHT_ERROR', 'ffmpeg is not an LGPL build', { reason: 'FFMPEG_LICENSE', detail: report.ffmpeg.license });
    }
    const outputDir = plan.output.directory;
    try {
      fs.mkdirSync(outputDir, { recursive: true });
      fs.accessSync(outputDir, fs.constants.W_OK);
    } catch (cause) {
      throw new ConversionError('PREFLIGHT_ERROR', 'Output folder is not writable', { reason: 'OUTPUT_NOT_WRITABLE', cause });
    }
    const outputId = plan.output.directoryId ?? directoryId(outputDir);
    assertOutputDirectory(outputDir, outputId);
    const tempRoot = options.tempRoot ?? defaultTempRoot();
    fs.mkdirSync(tempRoot, { recursive: true });
    const disk = plan.expected.disk;
    if (sameVolume(tempRoot, outputDir)) {
      if (freeBytes(outputDir) < disk.sameVolume) throw diskError(disk.sameVolume, freeBytes(outputDir));
    } else {
      if (freeBytes(tempRoot) < disk.temp) throw diskError(disk.temp, freeBytes(tempRoot));
      if (freeBytes(outputDir) < disk.output) throw diskError(disk.output, freeBytes(outputDir));
    }
    const sourceBefore = await fingerprint(plan.input.path, signal);
    sleep = await platform.preventSleep();

    const id = crypto.randomUUID();
    jobDir = fs.mkdtempSync(path.join(tempRoot, 'job-'));
    staging = safeChildPath(outputDir, `${STAGING_PREFIX}${id}${STAGING_SUFFIX}`);
    fs.writeFileSync(path.join(jobDir, 'owner.json'), JSON.stringify({
      pid: process.pid,
      processStart: await platform.processStartTime(process.pid),
      staging,
      createdAt: date.toISOString(),
    }));

    enter('ENCODING_PASS_1');
    const duration = plan.input.videoEnd;
    const encoded = await encode(plan, jobDir, {
      toolchain, signal, log,
      onProgress: (pass, time) => {
        const phase: ConversionPhase = pass === 1 ? 'ENCODING_PASS_1' : 'ENCODING_PASS_2';
        if (phase !== current) enter(phase);
        emit(phase, Math.min(1, time / duration), { time: Math.min(time, duration), duration });
      },
    });
    if ((current as ConversionPhase) !== 'ENCODING_PASS_2') enter('ENCODING_PASS_2');

    enter('AUTHORING');
    const authored = await author(jobDir, encoded.mpegPath, { toolchain, signal, log });
    fs.rmSync(encoded.mpegPath, { force: true });

    enter('CREATING_ZIP');
    const videoTsDir = path.join(staging, 'VIDEO_TS');
    const zipPath = path.join(staging, 'VIDEO_TS.zip');
    const isoPath = safeChildPath(staging, plan.output.isoFileName);
    assertOutputDirectory(outputDir, outputId);
    try {
      fs.mkdirSync(staging);
      assertOutputDirectory(outputDir, outputId, staging);
      moveDir(authored, videoTsDir);
    } catch (cause) {
      if (cause instanceof ConversionError) throw cause;
      throw new ConversionError('OUTPUT_ERROR', 'Could not write to the output folder', { reason: 'OUTPUT_IO', cause, detail: String(cause) });
    }
    await writeZip(videoTsDir, zipPath, { date, signal, onProgress: (b, t) => emit('CREATING_ZIP', b / t) })
      .catch((e: unknown) => { throw toConversionError(e, 'ZIP_ERROR'); });

    enter('CREATING_ISO');
    await writeDvdIso(videoTsDir, isoPath, { volumeLabel: plan.output.volumeLabel, date, signal, onProgress: (b, t) => emit('CREATING_ISO', b / t) })
      .catch((e: unknown) => { throw toConversionError(e, 'ISO_ERROR'); });

    enter('VERIFYING');
    const verification = await verifyOutput({
      plan, dir: staging, toolchain, platform, sourceBefore, signal, log,
      onProgress: (f) => emit('VERIFYING', f),
    });
    if (!verification.passed) {
      throw new ConversionError('VERIFY_ERROR', 'Output verification failed', {
        reason: verification.failed.join(','),
        detail: verification.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`).join('\n'),
      });
    }

    enter('FINALIZING');
    throwIfAborted(signal);
    assertOutputDirectory(outputDir, outputId, staging);
    const finalDir = finalize(staging, outputDir, plan.output.name);
    staging = null;
    enter('COMPLETED');
    return {
      outputDir: finalDir,
      videoTsDir: path.join(finalDir, 'VIDEO_TS'),
      zipPath: path.join(finalDir, 'VIDEO_TS.zip'),
      isoPath: safeChildPath(finalDir, plan.output.isoFileName),
      plan,
      toolchain: report,
      audio: { peakDbfs: encoded.audioPeakDbfs, gainDb: encoded.audioGainDb },
      verification,
      timingsMs: timings,
    };
  } catch (error) {
    if (signal?.aborted) throw cancelledError();
    const e = toConversionError(error, isIoError(error) ? 'OUTPUT_ERROR' : 'INTERNAL_ERROR');
    log({ level: 'error', event: 'job.failed', message: e.code, data: { phase: current, reason: e.reason ?? null } });
    throw e;
  } finally {
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
    if (jobDir) fs.rmSync(jobDir, { recursive: true, force: true });
    await sleep?.release();
    lock?.release();
  }
}

function diskError(needed: number, free: number): ConversionError {
  return new ConversionError('PREFLIGHT_ERROR', 'Not enough disk space', {
    reason: 'DISK_SPACE',
    detail: `need ${Math.ceil(needed / 1e6)} MB, free ${Math.floor(free / 1e6)} MB`,
  });
}

function isIoError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && ['EIO', 'ENOSPC', 'ENOENT', 'EROFS', 'EACCES', 'ENXIO', 'EPERM'].includes(code);
}

/** The folder a conversion would create now: `<name>`, or the first free `<name>-N` (display only). */
export function nextOutputDirectory(outputDir: string, name: string): string {
  for (let n = 1; ; n++) {
    const candidate = safeChildPath(outputDir, numberedName(name, n));
    if (!fs.existsSync(candidate)) return candidate;
  }
}

/**
 * Move the verified staging folder to `<name>`, `<name>-2`, ... without overwriting anything: reserve
 * the name with mkdir (fails if taken), then rename the staging folder over that empty folder.
 */
export function finalize(staging: string, outputDir: string, name: string): string {
  for (let n = 1; n < 1000; n++) {
    const candidate = safeChildPath(outputDir, numberedName(name, n));
    try {
      fs.mkdirSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw new ConversionError('OUTPUT_ERROR', 'Could not create the output folder', { reason: 'OUTPUT_IO', cause: error });
    }
    try {
      fs.renameSync(staging, candidate);
      return candidate;
    } catch (error) {
      try {
        fs.rmdirSync(candidate);
      } catch {
        // someone else wrote into it; leave it alone
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOTEMPTY' || code === 'EEXIST') continue;
      throw new ConversionError('OUTPUT_ERROR', 'Could not move the output into place', { reason: 'OUTPUT_IO', cause: error });
    }
  }
  throw new ConversionError('OUTPUT_ERROR', 'No free output folder name', { reason: 'OUTPUT_NAME' });
}

/**
 * Remove job folders (and their staging folders) left by crashed processes. Only folders created by
 * this core are touched: `<tempRoot>/job-*` with an owner.json, and staging folders named
 * `.mp4-to-ifo-<uuid>.partial`.
 */
export async function cleanupStaleJobs(options: { tempRoot?: string; platform?: PlatformAdapter } = {}): Promise<number> {
  const root = options.tempRoot ?? defaultTempRoot();
  const platform = options.platform ?? defaultPlatform();
  if (!fs.existsSync(root)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(root)) {
    if (!name.startsWith('job-')) continue;
    const dir = path.join(root, name);
    let owner: { pid?: number; processStart?: string | null; staging?: string } = {};
    try {
      owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')) as typeof owner;
    } catch {
      // no owner file: only remove when old enough that it cannot be a job being set up
      if (Date.now() - fs.statSync(dir).mtimeMs < 10 * 60_000) continue;
    }
    if (owner.pid && owner.pid !== process.pid) {
      let alive = true;
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code === 'EPERM';
      }
      if (alive) {
        const start = await platform.processStartTime(owner.pid);
        if (start === null || start === owner.processStart) continue; // still running
      }
    } else if (owner.pid === process.pid) continue;
    const s = owner.staging;
    if (s && path.basename(s).startsWith(STAGING_PREFIX) && path.basename(s).endsWith(STAGING_SUFFIX)) fs.rmSync(s, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    removed++;
  }
  return removed;
}
