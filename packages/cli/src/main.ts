#!/usr/bin/env node
// mp4-to-ifo command entry point.

import { createRequire } from 'node:module';
import * as core from '@mp4-to-ifo/core';
import { run } from './cli.ts';

// Single source of truth for the version: this package's package.json.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

process.exitCode = await run(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  stdin: process.stdin,
  onSignal(signal, handler) {
    process.on(signal, handler);
    return () => process.off(signal, handler);
  },
  forceExit(code) {
    process.exit(code);
  },
  version,
  core,
});
