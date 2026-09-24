// Single-layer DVD capacity, video bitrate and disk space. Values measured in Phase 2 (docs/poc.md §9.12).

/** DVD+R SL (2,295,104 sectors) is the smaller single-layer disc: 4,700,372,992 bytes. */
export const DVD_PLUS_R_SL_BYTES = 2_295_104 * 2048;
/** Usable target: ~150 MB below DVD+R SL for filesystem, rate-control error and content variance. */
export const TARGET_USABLE_BYTES = 4_550_000_000;
/** PS overhead model: measured 3.17% at 2 Mbps .. 1.71% at 8 Mbps (~1.16% + 45 kbps), modelled high. */
export const MUX_OVERHEAD_RATIO = 0.012;
export const MUX_OVERHEAD_KBPS = 50;

export const VIDEO_MAX_AVG_KBPS = 8000;
export const VIDEO_MAXRATE_KBPS = 9000;
export const AUDIO_KBPS = 256;
/** Below this the plan carries a LOW_BITRATE warning (DVD recorder SP ~4.6, LP ~2.3 Mbps). */
export const LOW_VIDEO_KBPS = 3500;
/** Below this the input does not fit a single-layer disc in any usable quality. */
export const MIN_VIDEO_KBPS = 1000;

/** Average video bitrate for a duration, capped at the DVD quality ceiling. */
export function videoBitrateKbps(durationSec: number): number {
  const muxedKbps = (TARGET_USABLE_BYTES * 8 / durationSec / 1000 - MUX_OVERHEAD_KBPS) / (1 + MUX_OVERHEAD_RATIO);
  return Math.min(VIDEO_MAX_AVG_KBPS, Math.floor(muxedKbps - AUDIO_KBPS));
}

/** Expected VOB bytes (upper estimate: 2-pass lands within +0.05% of target, simple content lands lower). */
export function expectedStreamBytes(videoKbps: number, durationSec: number): number {
  const muxedKbps = (videoKbps + AUDIO_KBPS) * (1 + MUX_OVERHEAD_RATIO) + MUX_OVERHEAD_KBPS;
  return Math.ceil(muxedKbps * 1000 * durationSec / 8);
}

/** IFO/BUP, ISO9660/UDF metadata and VMG padding: ~1 MB measured; reserve 4 MB. */
export const FILESYSTEM_RESERVE_BYTES = 4 * 1024 * 1024;
const DISK_MARGIN_RATIO = 0.05;
const DISK_MARGIN_BYTES = 64 * 1024 * 1024;

export interface DiskRequirement {
  /** Bytes needed on the temporary volume (title MPEG + authored VIDEO_TS). */
  temp: number;
  /** Bytes needed on the output volume (VIDEO_TS + ZIP + ISO). */
  output: number;
  /** Bytes needed when both are the same volume (peak). */
  sameVolume: number;
}

/**
 * Peak disk use. Temp: title.mpg + VIDEO_TS until the MPEG is deleted (2x). Output: VIDEO_TS, ZIP and
 * ISO (3x). On one volume VIDEO_TS is renamed, not copied, so the peak is 3x.
 */
export function diskRequirement(streamBytes: number, frameCount: number): DiskRequirement {
  const passLog = frameCount * 256;
  const margin = (n: number) => Math.ceil(n * (1 + DISK_MARGIN_RATIO)) + DISK_MARGIN_BYTES;
  const copy = streamBytes + FILESYSTEM_RESERVE_BYTES;
  return {
    temp: margin(2 * copy + passLog),
    output: margin(3 * copy),
    sameVolume: margin(3 * copy + passLog),
  };
}
