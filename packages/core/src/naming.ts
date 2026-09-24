// User-facing output names (keep the source name) and the internal DVD volume label (strict).

import path from 'node:path';
import { ConversionError } from './errors.ts';

/** Longest output folder name in UTF-8 bytes, leaving room for "-NN", ".iso" and staging names under 255. */
const MAX_NAME_BYTES = 200;

/**
 * Output folder / ISO base name from the source file name. Japanese, spaces and most symbols are
 * kept; only characters unsafe on common filesystems are replaced.
 */
export function outputBaseName(sourcePath: string): string {
  let name = path
    .parse(sourcePath)
    .name.replace(/[/\\:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .replace(/^[.\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (Buffer.byteLength(name) > MAX_NAME_BYTES) {
    const chars = [...name];
    while (Buffer.byteLength(chars.join('')) > MAX_NAME_BYTES) chars.pop();
    name = chars.join('').replace(/[.\s]+$/, '');
  }
  return name || 'dvd';
}

/** Candidate folder names: name, name-2, name-3, ... */
export function numberedName(base: string, n: number): string {
  return n <= 1 ? base : `${base}-${n}`;
}

/** Volume label length that fits both ISO9660 d-characters (32) and a UDF 8-bit dstring (30). */
export const VOLUME_LABEL_MAX = 30;

/** DVD volume label: A-Z 0-9 _ only, e.g. "opening-movie.mp4" -> "OPENING_MOVIE". */
export function volumeLabel(sourcePath: string): string {
  const label = path
    .parse(sourcePath)
    .name.normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, VOLUME_LABEL_MAX)
    .replace(/_+$/, '');
  return label || 'DVD_VIDEO';
}

/**
 * `<parent>/<name>` for a single file or folder name, refusing anything that could land elsewhere:
 * separators, `.` / `..`, absolute names, NUL, or a result outside `parent`. Output names come from the
 * core's own plan; this keeps them inside the staging and output folders whatever the name holds.
 */
export function safeChildPath(parent: string, name: string): string {
  const bad = !name || name === '.' || name === '..' || /[/\\\u0000]/.test(name) || path.isAbsolute(name) || name !== path.basename(name);
  const resolvedParent = path.resolve(parent);
  const child = path.resolve(resolvedParent, name);
  if (bad || path.dirname(child) !== resolvedParent) {
    throw new ConversionError('OUTPUT_ERROR', 'Output name is not a plain file name', { reason: 'OUTPUT_NAME' });
  }
  return child;
}
