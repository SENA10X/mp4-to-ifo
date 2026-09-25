// External tools. Paths are injected (e.g. Tauri sidecars) or resolved from PATH; never hard-coded.

import fs from 'node:fs';
import path from 'node:path';
import { ConversionError } from './errors.ts';
import { runTool } from './process.ts';

export interface Toolchain {
  ffmpeg: string;
  ffprobe: string;
  dvdauthor: string;
}

export type FfmpegLicense = 'lgpl' | 'gpl' | 'nonfree' | 'unknown';

export interface ToolchainReport {
  ffmpeg: { path: string; version: string; license: FfmpegLicense; configuration: string };
  ffprobe: { path: string; version: string };
  dvdauthor: { path: string; version: string };
  /** Required codecs/filters/muxers the ffmpeg build lacks. */
  missing: string[];
  /** Filters only needed for experimental HDR tone mapping that are missing. */
  missingExperimental: string[];
}

/** Filters, encoders and muxers the conversion pipeline uses (all LGPL in FFmpeg 7.1). */
export const REQUIRED_FFMPEG_FEATURES = {
  filters: ['scale', 'pad', 'tpad', 'fps', 'setsar', 'setfield', 'separatefields', 'select', 'weave', 'telecine', 'fieldorder', 'estdif', 'format', 'pan', 'volume', 'astats', 'aresample', 'anullsrc', 'showinfo'],
  encoders: ['mpeg2video', 'ac3'],
  muxers: ['dvd'],
} as const;

export const EXPERIMENTAL_FFMPEG_FILTERS = ['zscale', 'tonemap'] as const;

/**
 * GPL-only filters in FFmpeg 7.1 (`*_filter_deps="gpl"` in configure). They must never appear in a
 * production filter graph; a test checks every generated graph against this list.
 */
export const GPL_ONLY_FILTERS = ['blackframe', 'boxblur', 'boxblur_opencl', 'colormatrix', 'cover_rect', 'cropdetect', 'delogo', 'eq', 'find_rect', 'fspp', 'histeq', 'hqdn3d', 'interlace', 'kerndeint', 'mcdeint', 'mpdecimate', 'mptestsrc', 'nnedi', 'owdenoise', 'perspective', 'phase', 'pp7', 'pp', 'pullup', 'repeatfields', 'sab', 'signature', 'smartblur', 'spp', 'stereo3d', 'super2xsai', 'tinterlace', 'uspp', 'vaguedenoiser'] as const;

/** Find an executable on PATH (no shell). */
export function findOnPath(name: string, envPath = process.env.PATH ?? ''): string | null {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/** Resolve tool paths: explicit overrides win, otherwise PATH. */
export function resolveToolchain(overrides: Partial<Toolchain> = {}, envPath?: string): Toolchain {
  const resolve = (name: keyof Toolchain): string => {
    const explicit = overrides[name];
    if (explicit) {
      try {
        fs.accessSync(explicit, fs.constants.X_OK);
        return explicit;
      } catch {
        throw new ConversionError('PREFLIGHT_ERROR', `${name} is not executable`, { reason: 'TOOL_MISSING', detail: explicit });
      }
    }
    const found = findOnPath(name, envPath);
    if (!found) throw new ConversionError('PREFLIGHT_ERROR', `${name} was not found`, { reason: 'TOOL_MISSING' });
    return found;
  };
  return { ffmpeg: resolve('ffmpeg'), ffprobe: resolve('ffprobe'), dvdauthor: resolve('dvdauthor') };
}

function listNames(output: string): Set<string> {
  // Lines look like " V....D mpeg2video  MPEG-2 video" or " ... scale  V->V  Scale ..."
  const names = new Set<string>();
  for (const line of output.split('\n')) {
    const m = /^\s*[A-Z.|]{2,}\s+(\S+)/.exec(line);
    if (m?.[1]) names.add(m[1]);
  }
  return names;
}

export function licenseFromConfiguration(configuration: string, rawLicenseText: string): FfmpegLicense {
  const licenseText = rawLicenseText.replace(/\s+/g, ' '); // `ffmpeg -L` wraps lines mid-phrase
  if (/--enable-nonfree/.test(configuration) || /nonfree and unredistributable/i.test(licenseText)) return 'nonfree';
  if (/--enable-gpl/.test(configuration) || /GNU General Public License/.test(licenseText)) return 'gpl';
  if (/GNU Lesser General Public License/.test(licenseText)) return 'lgpl';
  return 'unknown';
}

/** Inspect versions, license and capabilities. */
export async function inspectToolchain(toolchain: Toolchain, signal?: AbortSignal): Promise<ToolchainReport> {
  const opts = { errorCode: 'PREFLIGHT_ERROR' as const, signal };
  const version = await runTool(toolchain.ffmpeg, ['-hide_banner', '-version'], opts);
  const license = await runTool(toolchain.ffmpeg, ['-hide_banner', '-L'], opts);
  const filters = await runTool(toolchain.ffmpeg, ['-hide_banner', '-filters'], opts);
  const encoders = await runTool(toolchain.ffmpeg, ['-hide_banner', '-encoders'], opts);
  const muxers = await runTool(toolchain.ffmpeg, ['-hide_banner', '-muxers'], opts);
  const probeVersion = await runTool(toolchain.ffprobe, ['-hide_banner', '-version'], opts);
  // dvdauthor prints its banner to stderr and exits non-zero without arguments.
  const dvd = await runTool(toolchain.dvdauthor, ['-h'], { ...opts, okCodes: [0, 1] });

  const configuration = /configuration:\s*(.*)/.exec(version.stdout)?.[1]?.trim() ?? '';
  const filterNames = listNames(filters.stdout);
  const encoderNames = listNames(encoders.stdout);
  const muxerNames = new Set([...muxers.stdout.matchAll(/^\s*[D ]E\s+(\S+)/gm)].flatMap((m) => (m[1] ?? '').split(',')));

  const missing = [
    ...REQUIRED_FFMPEG_FEATURES.filters.filter((f) => !filterNames.has(f)).map((f) => `filter:${f}`),
    ...REQUIRED_FFMPEG_FEATURES.encoders.filter((e) => !encoderNames.has(e)).map((e) => `encoder:${e}`),
    ...REQUIRED_FFMPEG_FEATURES.muxers.filter((m) => !muxerNames.has(m)).map((m) => `muxer:${m}`),
  ];
  return {
    ffmpeg: {
      path: toolchain.ffmpeg,
      version: /ffmpeg version (\S+)/.exec(version.stdout)?.[1] ?? 'unknown',
      license: licenseFromConfiguration(configuration, license.stdout),
      configuration,
    },
    ffprobe: { path: toolchain.ffprobe, version: /ffprobe version (\S+)/.exec(probeVersion.stdout)?.[1] ?? 'unknown' },
    dvdauthor: { path: toolchain.dvdauthor, version: /version ([\d.]+)/.exec(dvd.stderr + dvd.stdout)?.[1] ?? 'unknown' },
    missing,
    missingExperimental: EXPERIMENTAL_FFMPEG_FILTERS.filter((f) => !filterNames.has(f)),
  };
}
