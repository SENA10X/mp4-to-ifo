// External process execution: argument arrays only (never a shell), cancellable with an
// AbortSignal, bounded output capture.

import { spawn } from 'node:child_process';
import { ConversionError, cancelledError, type ErrorCode } from './errors.ts';
import type { LogSink } from './log.ts';

const STDERR_TAIL_BYTES = 64 * 1024;
const KILL_GRACE_MS = 3000;

export interface RunOptions {
  /** Error code used when the tool fails. */
  errorCode: ErrorCode;
  signal?: AbortSignal;
  cwd?: string;
  env?: Record<string, string>;
  /** Called for every complete stdout line (text mode only). */
  onStdoutLine?: (line: string) => void;
  /** Called for every complete stderr line. */
  onStderrLine?: (line: string) => void;
  /** Collect stdout as a Buffer instead of text. */
  binary?: boolean;
  /** Maximum stdout bytes kept (default 256 MiB). */
  maxStdout?: number;
  /** Exit codes treated as success (default [0]). */
  okCodes?: number[];
  log?: LogSink;
}

export interface RunResult {
  code: number;
  stdout: string;
  stdoutBuffer: Buffer;
  stderr: string;
}

export function runTool(command: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
  const { signal, errorCode } = options;
  if (signal?.aborted) return Promise.reject(cancelledError());
  const maxStdout = options.maxStdout ?? 256 * 1024 * 1024;
  const okCodes = options.okCodes ?? [0];
  options.log?.({ level: 'debug', event: 'tool.exec', message: toolName(command), data: { args: args.length } });

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    const stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stdoutOverflow = false;
    let stderrTail = '';
    let stdoutPartial = '';
    let stderrPartial = '';
    let killTimer: NodeJS.Timeout | undefined;
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes + chunk.length > maxStdout) stdoutOverflow = true;
      else {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
      if (options.onStdoutLine && !options.binary) {
        stdoutPartial += chunk.toString('utf8');
        const lines = stdoutPartial.split('\n');
        stdoutPartial = lines.pop() ?? '';
        for (const line of lines) options.onStdoutLine(line);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrTail = (stderrTail + text).slice(-STDERR_TAIL_BYTES);
      if (options.onStderrLine) {
        stderrPartial += text;
        const lines = stderrPartial.split('\n');
        stderrPartial = lines.pop() ?? '';
        for (const line of lines) options.onStderrLine(line);
      }
    });

    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(new ConversionError(errorCode, `${toolName(command)} could not be started`, { cause: error, detail: error.message }));
    });
    child.on('close', (code, sig) => {
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
      if (stderrPartial && options.onStderrLine) options.onStderrLine(stderrPartial);
      if (stdoutPartial && options.onStdoutLine) options.onStdoutLine(stdoutPartial);
      if (aborted || signal?.aborted) {
        reject(cancelledError());
        return;
      }
      const stdoutBuffer = Buffer.concat(stdoutChunks);
      if (stdoutOverflow) {
        reject(new ConversionError(errorCode, `${toolName(command)} produced more output than expected`));
        return;
      }
      if (code === null || !okCodes.includes(code)) {
        reject(new ConversionError(errorCode, `${toolName(command)} failed (${code ?? sig})`, {
          detail: tailLines(stderrTail, 30),
          exitCode: code,
        }));
        return;
      }
      resolve({
        code,
        stdout: options.binary ? '' : stdoutBuffer.toString('utf8'),
        stdoutBuffer,
        stderr: stderrTail,
      });
    });
  });
}

export function toolName(command: string): string {
  return command.split('/').pop() ?? command;
}

export function tailLines(text: string, lines: number): string {
  return text.trim().split('\n').slice(-lines).join('\n');
}
