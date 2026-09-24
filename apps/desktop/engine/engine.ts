// Desktop engine: runs the conversion core for the Tauri app, one process per operation.
//
//   node engine.js analyze <input.mp4> [--output <dir>]   -> one JSON line, then exit
//   node engine.js convert                                  -> reads one JSON line (job) from stdin,
//                                                              writes JSON lines (progress, result)
// Tools come from --tools <dir> (the app bundle), never from PATH. While converting, "cancel" on stdin
// or stdin closing (the app went away) aborts the job, so the core stops ffmpeg and cleans up.
//
// Trust boundary: the UI chooses only the input file and the output folder. A convert job is exactly
// { input, outputDirectory, planDigest }; the core plans again from the file and refuses to convert
// when that plan is not the one the user saw (planDigest). No conversion setting, output name or path
// inside the output folder comes from the UI.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import * as core from '@mp4-to-ifo/core';

export type EngineMessage =
  /** plan is for display; planDigest identifies it when the user converts. */
  | { type: 'plan'; analysis: AnalysisSummary; plan: core.ConversionPlan; planDigest: string; outputFolder: string }
  | { type: 'progress'; event: core.ProgressEvent }
  | { type: 'done'; result: ResultSummary }
  | { type: 'error'; error: EngineError };

export interface AnalysisSummary {
  fileName: string;
  width: number;
  height: number;
  duration: number;
  frameRate: number;
  variableFrameRate: boolean;
  audio: { channels: number; layout: string | null; codec: string } | null;
}

export interface ResultSummary {
  outputDir: string;
  isoFileName: string;
  checks: number;
  notMeasured: number;
}

export interface EngineError {
  code: string;
  reason: string | null;
  /** Plan error codes when the input cannot be converted. */
  planErrors: core.PlanIssue[];
  /** Redacted report for "Copy Error Details" (createErrorReport). */
  report: core.ErrorReport;
}

interface Args {
  command: string;
  input: string | null;
  output: string | null;
  tools: string;
  version: string;
}

function parse(argv: string[]): Args {
  const value = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? (argv[i + 1] ?? null) : null;
  };
  return {
    command: argv[0] ?? '',
    input: argv[0] === 'analyze' ? (argv[1] ?? null) : null,
    output: value('--output'),
    tools: value('--tools') ?? '',
    version: value('--app-version') ?? '0.0.0',
  };
}

function toolchain(dir: string): core.Toolchain {
  return core.resolveToolchain({
    ffmpeg: path.join(dir, 'ffmpeg'),
    ffprobe: path.join(dir, 'ffprobe'),
    dvdauthor: path.join(dir, 'dvdauthor'),
  });
}

// When the app goes away (even kill -9), writes fail with EPIPE. That must not crash the engine before the
// core has stopped ffmpeg and cleaned up: later messages are dropped and the conversion is aborted.
const appGone = new AbortController();
process.stdout.on('error', () => appGone.abort());

function emit(message: EngineMessage): void {
  if (!appGone.signal.aborted) process.stdout.write(`${JSON.stringify(message)}\n`);
}

function engineError(error: unknown, sensitive: string[], plan: core.ConversionPlan | null, version: string): EngineError {
  const e = error as core.ConversionError;
  const reason = e.reason ?? null;
  return {
    code: e instanceof core.ConversionError ? e.code : 'INTERNAL_ERROR',
    reason,
    planErrors: plan?.errors.filter((i) => (reason ?? '').split(',').includes(i.code)) ?? [],
    report: core.createErrorReport(error, { sensitive, app: { desktop: version } }),
  };
}

function summarize(a: core.InputAnalysis): AnalysisSummary {
  const track = a.selectedAudio === null ? null : a.audioTracks[a.selectedAudio];
  const rotated = Math.abs(a.video.rotation) % 180 === 90;
  return {
    fileName: path.basename(a.path),
    width: rotated ? a.video.height : a.video.width,
    height: rotated ? a.video.width : a.video.height,
    duration: a.duration,
    frameRate: a.video.frameRate,
    variableFrameRate: a.video.isVariableFrameRate,
    audio: track ? { channels: track.channels, layout: track.channelLayout, codec: track.codec } : null,
  };
}

function invalid(what: string): core.ConversionError {
  return new core.ConversionError('INPUT_ERROR', `Invalid ${what}`, { reason: 'INVALID_JOB' });
}

/** An absolute, normalized path (no `..`, no trailing separator, no NUL). */
function plainAbsolute(value: unknown, what: string): string {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value || value.includes('\0')) throw invalid(what);
  return value;
}

/** The output folder the user chose: an existing directory. */
function outputFolder(value: unknown): string {
  const dir = plainAbsolute(value, 'output folder');
  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch {
    // missing
  }
  if (!isDir) throw invalid('output folder');
  return dir;
}

async function analyze(args: Args): Promise<number> {
  const input = path.resolve(args.input ?? '');
  try {
    const { analysis, plan } = await core.analyzeAndPlan(input, {
      toolchain: toolchain(args.tools),
      outputDirectory: args.output === null ? undefined : outputFolder(args.output),
    });
    emit({
      type: 'plan', analysis: summarize(analysis), plan, planDigest: core.planDigest(plan),
      outputFolder: core.nextOutputDirectory(plan.output.directory, plan.output.name),
    });
    return 0;
  } catch (error) {
    emit({ type: 'error', error: engineError(error, [input, ...(args.output ? [args.output] : [])], null, args.version) });
    return core.exitCodeFor(error);
  }
}

interface Job {
  input: string;
  outputDirectory: string;
  planDigest: string;
}

/** The job line from the app: exactly these three fields, or nothing is done. */
function parseJob(line: string): Job {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw invalid('job');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('job');
  const job = raw as Record<string, unknown>;
  const keys = Object.keys(job).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['input', 'outputDirectory', 'planDigest'])) throw invalid('job');
  if (typeof job.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(job.planDigest)) throw invalid('plan');
  return { input: plainAbsolute(job.input, 'input'), outputDirectory: outputFolder(job.outputDirectory), planDigest: job.planDigest };
}

async function convert(args: Args): Promise<number> {
  const controller = new AbortController();
  const lines = readline.createInterface({ input: process.stdin });
  const line = await new Promise<string | null>((resolve) => {
    lines.once('line', resolve);
    lines.once('close', () => resolve(null));
  });
  if (line === null) return 4;
  let job: Job;
  try {
    job = parseJob(line);
  } catch (error) {
    lines.close();
    emit({ type: 'error', error: engineError(error, [], null, args.version) });
    return core.exitCodeFor(error);
  }
  // After the job line: "cancel" or end of input (the app quit or crashed) aborts the conversion.
  lines.on('line', (line) => {
    if (line.trim() === 'cancel') controller.abort();
  });
  lines.on('close', () => controller.abort());
  appGone.signal.addEventListener('abort', () => controller.abort());
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => controller.abort());

  try {
    const platform = core.defaultPlatform();
    await core.cleanupStaleJobs({ platform });
    const result = await core.convert({
      input: job.input,
      outputDirectory: job.outputDirectory,
      planDigest: job.planDigest,
      toolchain: toolchain(args.tools),
      platform,
      requireLgpl: true,
      signal: controller.signal,
      onProgress: (event) => emit({ type: 'progress', event }),
    });
    const v = result.verification;
    emit({
      type: 'done',
      result: {
        outputDir: result.outputDir,
        isoFileName: path.basename(result.isoPath),
        checks: v.checks.length,
        notMeasured: v.checks.filter((c) => c.status === 'unmeasurable').length,
      },
    });
    return 0;
  } catch (error) {
    emit({ type: 'error', error: engineError(error, [job.input, job.outputDirectory], null, args.version) });
    return core.exitCodeFor(error);
  } finally {
    lines.close();
  }
}

const args = parse(process.argv.slice(2));
process.exitCode = args.command === 'analyze' ? await analyze(args) : args.command === 'convert' ? await convert(args) : 2;
// Nothing should keep running once the operation is over (the app waits for this process to exit).
process.exit();
