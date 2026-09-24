// Command-line arguments. Only operational options: the DVD settings are not user-configurable.

import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

export interface CliArgs {
  input: string | null;
  output: string | null;
  yes: boolean;
  verbose: boolean;
  help: boolean;
  version: boolean;
}

export class UsageError extends Error {}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        output: { type: 'string', short: 'o' },
        yes: { type: 'boolean', short: 'y' },
        verbose: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
      },
    });
  } catch (error) {
    throw new UsageError(describeParseError(error as Error & { code?: string }));
  }
  const { values, positionals } = parsed;
  if (positionals.length > 1) throw new UsageError('Only one input file can be converted at a time.');
  if (values.output === '') throw new UsageError('--output needs a directory.');
  return {
    input: positionals[0] ?? null,
    output: values.output === undefined ? null : expandHome(values.output),
    yes: values.yes ?? false,
    verbose: values.verbose ?? false,
    help: values.help ?? false,
    version: values.version ?? false,
  };
}

function describeParseError(error: Error & { code?: string }): string {
  const option = /'([^']+)'/.exec(error.message)?.[1];
  if (error.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') return `Unknown option: ${option ?? error.message}`;
  if (error.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') return `${option ?? 'An option'} needs a value.`;
  return error.message;
}

/** `--output=~/Desktop` is not expanded by the shell. */
function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function usage(version: string): string {
  return `MP4 to IFO ${version}
Convert an MP4 video into DVD-Video files for disc authoring.

Usage:
  mp4-to-ifo <input.mp4> [options]

Options:
  -o, --output <directory>  Folder to create the output in (default: next to the input)
  -y, --yes                 Convert without asking for confirmation
      --verbose             Show more detail
  -h, --help                Show this help
      --version             Show the version

Creates <name>/VIDEO_TS/, <name>/VIDEO_TS.zip and <name>/<name>.iso.
`;
}
