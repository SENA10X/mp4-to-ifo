// Structured log events and redaction for error reports.
// Events never carry paths in `data`; anything user-identifying goes through `redact()`.

import os from 'node:os';
import path from 'node:path';
import { ConversionError } from './errors.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEvent {
  level: LogLevel;
  /** Stable event name, e.g. 'tool.exec', 'verify.check'. */
  event: string;
  message: string;
  data?: Record<string, string | number | boolean | null>;
}

export type LogSink = (event: LogEvent) => void;

export const noopLog: LogSink = () => {};

/**
 * Replace every occurrence of the given sensitive strings (paths, file names) and the
 * user's home directory with placeholders.
 */
export function redact(text: string, sensitive: readonly string[]): string {
  const replacements: [string, string][] = [];
  for (const value of sensitive) {
    if (!value) continue;
    replacements.push([value, '<path>']);
    const base = path.basename(value);
    if (base && base !== value) replacements.push([base, '<name>']);
    const stem = path.parse(value).name;
    if (stem && stem.length >= 3 && stem !== base) replacements.push([stem, '<name>']);
  }
  const home = os.homedir();
  if (home) replacements.push([home, '~']);
  // Longest first so a full path is replaced before its basename.
  replacements.sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [from, to] of replacements) out = out.split(from).join(to);
  return out;
}

export interface ErrorReport {
  code: string;
  reason: string | null;
  message: string;
  detail: string | null;
  exitCode: number | null;
  phase: string | null;
  app: Record<string, string>;
}

/**
 * Build a copyable, redacted error report. `sensitive` should list the input path,
 * output directory and any derived names.
 */
export function createErrorReport(
  error: unknown,
  options: { sensitive: readonly string[]; phase?: string | null; app?: Record<string, string> },
): ErrorReport {
  const e = error instanceof ConversionError ? error : null;
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: e?.code ?? 'INTERNAL_ERROR',
    reason: e?.reason ?? null,
    message: redact(message, options.sensitive),
    detail: e?.detail ? redact(e.detail, options.sensitive) : null,
    exitCode: e?.exitCode ?? null,
    phase: options.phase ?? null,
    app: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      ...options.app,
    },
  };
}
