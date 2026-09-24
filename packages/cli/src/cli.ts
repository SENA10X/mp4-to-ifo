// The CLI: arguments -> core API -> terminal output -> exit code. All conversion work is the core's.

import path from 'node:path';
import readline from 'node:readline';
import * as realCore from '@mp4-to-ifo/core';
import type { ConversionError, ConversionPlan } from '@mp4-to-ifo/core';
import { UsageError, parseCliArgs, usage } from './args.ts';
import { ProgressView, errorText, planErrorText, success, summary, toolchainText, warningText, type Output } from './render.ts';

export type Core = Pick<typeof realCore,
  'resolveToolchain' | 'inspectToolchain' | 'analyzeAndPlan' | 'convert' | 'acquireLock' | 'defaultPlatform' |
  'cleanupStaleJobs' | 'nextOutputDirectory' | 'exitCodeFor' | 'createErrorReport' | 'planDigest'>;

export interface CliEnvironment {
  stdout: Output;
  stderr: Output;
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  /** Signal subscription (process by default). */
  onSignal(signal: 'SIGINT' | 'SIGTERM', handler: () => void): () => void;
  /** Immediate exit, used only when the user insists (third Ctrl+C). */
  forceExit(code: number): void;
  version: string;
  core: Core;
}

const EXIT_USAGE = 2;
const EXIT_CANCELLED = 4;

export async function run(argv: readonly string[], env: CliEnvironment): Promise<number> {
  const { stdout, stderr, core } = env;
  let args;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    stderr.write(`Error: ${error.message}\n\n${usage(env.version)}`);
    return EXIT_USAGE;
  }
  if (args.help) {
    stdout.write(usage(env.version));
    return 0;
  }
  if (args.version) {
    stdout.write(`${env.version}\n`);
    return 0;
  }
  if (!args.input) {
    stderr.write(usage(env.version));
    return EXIT_USAGE;
  }

  const input = path.resolve(args.input);
  const outputDirectory = args.output ? path.resolve(args.output) : undefined;
  const controller = new AbortController();
  const progress = new ProgressView(stdout);
  let signals = 0;
  const onSignal = () => {
    signals++;
    if (signals === 1) {
      progress.endLine();
      stderr.write('Cancelling... (cleaning up)\n');
      controller.abort();
    } else if (signals === 2) {
      stderr.write('Still cleaning up. Press Ctrl+C again to quit immediately (temporary files may be left).\n');
    } else env.forceExit(EXIT_CANCELLED);
  };
  const unsubscribe = [env.onSignal('SIGINT', onSignal), env.onSignal('SIGTERM', onSignal)];

  let plan: ConversionPlan | null = null;
  try {
    stdout.write(`MP4 to IFO ${env.version}\n\n`);
    const toolchain = core.resolveToolchain();
    if (args.verbose) stdout.write(toolchainText(await core.inspectToolchain(toolchain, controller.signal)));
    const platform = core.defaultPlatform();
    const removed = await core.cleanupStaleJobs({ platform });
    if (args.verbose && removed) stdout.write(`Removed ${removed} unfinished job folder(s) from an earlier run.\n\n`);

    stdout.write('Analyzing...\n\n');
    const planned = await core.analyzeAndPlan(input, { toolchain, outputDirectory, signal: controller.signal });
    plan = planned.plan;
    stdout.write(summary(planned.analysis, plan, core.nextOutputDirectory(plan.output.directory, plan.output.name), args.verbose));
    for (const w of plan.warnings) stdout.write(`\nWarning: ${indent(warningText(w))}\n`);
    if (plan.errors.length) {
      for (const e of plan.errors) stderr.write(`\nError: ${indent(planErrorText(e))}\n`);
      return EXIT_USAGE;
    }

    // Fail before asking if another conversion holds the lock (the core locks again for real).
    (await core.acquireLock({ platform })).release();

    if (!args.yes) {
      if (!env.stdin.isTTY) {
        stderr.write('\nError: Confirmation needed. Run with --yes to convert without a prompt.\n');
        return EXIT_USAGE;
      }
      const answer = await ask(env, '\nContinue? [Y/n] ', controller.signal);
      if (answer === null || !/^(y|yes|)$/i.test(answer.trim())) {
        stdout.write('Cancelled. Nothing was converted.\n');
        return EXIT_CANCELLED;
      }
    }
    stdout.write('\n');

    const result = await core.convert({
      // The core plans again and refuses to convert if that differs from the plan shown above.
      input, toolchain, planDigest: core.planDigest(plan), outputDirectory, platform, signal: controller.signal,
      onProgress: (e) => progress.update(e),
    });
    progress.endLine();
    stdout.write(success(result, args.verbose));
    return 0;
  } catch (error) {
    progress.endLine();
    const e = error as ConversionError;
    stderr.write(`\nError: ${indent(errorText(e, plan))}\n`);
    if (args.verbose) {
      const report = core.createErrorReport(e, { sensitive: [input, ...(outputDirectory ? [outputDirectory] : [])], app: { cli: env.version } });
      stderr.write(`\nError report (paths and file names removed):\n${JSON.stringify(report, null, 2)}\n`);
    } else if (e.code !== 'CANCELLED') stderr.write('Run again with --verbose for more details.\n');
    return core.exitCodeFor(e);
  } finally {
    for (const off of unsubscribe) off();
  }
}

/** Indent continuation lines under "Warning: " / "Error: " (blank lines stay empty). */
function indent(text: string): string {
  return text.split('\n').map((line, i) => (i && line ? `  ${line}` : line)).join('\n');
}

/** One line from a TTY. Resolves null when cancelled (Ctrl+C or a signal). */
function ask(env: CliEnvironment, question: string, signal: AbortSignal): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: env.stdin, terminal: false });
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', onAbort);
      rl.close();
      resolve(value);
    };
    const onAbort = () => finish(null);
    signal.addEventListener('abort', onAbort);
    rl.on('SIGINT', () => finish(null));
    rl.on('close', () => finish(null));
    env.stdout.write(question);
    rl.once('line', (line) => finish(line));
  });
}
