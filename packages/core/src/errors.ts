// Typed errors. The core never exits the process; callers map errors with exitCodeFor().

export const ERROR_CODES = [
  'INPUT_ERROR',
  'PREFLIGHT_ERROR',
  'ENCODE_ERROR',
  'AUTHOR_ERROR',
  'ZIP_ERROR',
  'ISO_ERROR',
  'VERIFY_ERROR',
  'OUTPUT_ERROR',
  'CANCELLED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ConversionErrorOptions {
  /** Machine-readable sub-reason, e.g. 'LOCKED', 'TRUNCATED', 'DISK_SPACE'. */
  reason?: string;
  /** Technical detail such as a tool's stderr tail. May contain paths; redact before showing. */
  detail?: string;
  /** Tool exit code, when the error came from an external tool. */
  exitCode?: number | null;
  cause?: unknown;
}

export class ConversionError extends Error {
  readonly code: ErrorCode;
  readonly reason: string | undefined;
  readonly detail: string | undefined;
  readonly exitCode: number | null | undefined;

  constructor(code: ErrorCode, message: string, options: ConversionErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ConversionError';
    this.code = code;
    this.reason = options.reason;
    this.detail = options.detail;
    this.exitCode = options.exitCode;
  }
}

export function isCancelled(error: unknown): boolean {
  return error instanceof ConversionError && error.code === 'CANCELLED';
}

export function cancelledError(): ConversionError {
  return new ConversionError('CANCELLED', 'Conversion was cancelled');
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledError();
}

/** Wrap anything thrown into a ConversionError, keeping existing ones. */
export function toConversionError(error: unknown, fallback: ErrorCode = 'INTERNAL_ERROR'): ConversionError {
  if (error instanceof ConversionError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ConversionError(fallback, message, { cause: error });
}

/** CLI exit codes from the requirements: 0 success, 1 conversion failure, 2 input, 3 verification, 4 cancelled. */
export function exitCodeFor(error: unknown): 1 | 2 | 3 | 4 {
  if (!(error instanceof ConversionError)) return 1;
  switch (error.code) {
    case 'INPUT_ERROR':
      return 2;
    case 'VERIFY_ERROR':
      return 3;
    case 'CANCELLED':
      return 4;
    default:
      return 1;
  }
}
