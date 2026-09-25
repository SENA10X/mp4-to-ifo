// Field temporal check: how many distinct moments of the source reach the output fields, and in what
// order. The Phase 5.1 review converted 60p to 29.97p but kept the label interlace-60i: every picture
// that remained was shown at the right time, so timing checks passed while half the motion was gone.
//
// Independent of the generator: nothing here uses frame-rate.ts (filters or expectedDisplayTime), and
// the decoding is its own. Each output frame is split into its two fields (display order from the
// frame's own field-order flag); each source frame is scaled to the active area's height and split
// into the same two line sets, so a field is compared with source pictures of the same parity. Every output
// field is matched by content to the most similar source frame; distinct source moments are counted
// from the source alone. The only input from the plan besides geometry and colour matrix is the
// strategy's claimed temporal capacity (59.94i carries up to 59.94 moments per second, 3:2 pulldown
// 23.976, the progressive strategies 29.97).
//
// The same comparison gives the picture change points for sync.ts: where the output first shows a
// source moment, against where that moment starts in the source. Repeated or indistinguishable source
// frames are one moment (Phase 5.2): which of several identical frames a field "matches" carries no
// timing information, so only the change into a moment is timed.

import { runTool } from '../process.ts';
import type { FrameRateStrategyId } from '../profile/frame-rate.ts';
import type { ActiveArea } from '../profile/video.ts';
import type { Toolchain } from '../toolchain.ts';

const W = 64;
const H = 48;
const PIXELS = W * H;
/** Moments are counted this far inside the window (display and source times differ by < 50 ms). */
const EDGE_SEC = 0.1;
/** Fields are compared with source frames at most this far apart in time. */
const SEARCH_SEC = 0.25;
/**
 * Pictures and sound are also looked for this far away (M-3), only to find a match that lies outside
 * the search: then the output shows the source, at the wrong time. Nothing within it is accepted that
 * was not before; the timing tolerance is unchanged.
 */
export const WIDE_SEARCH_SEC = 1;
/** Output window per position; source frames are decoded this much wider on each side. */
const WINDOW_SEC = 1.2;
const SOURCE_MARGIN_SEC = WIDE_SEARCH_SEC + 0.1;
/** Match score below which a field is not treated as showing any source frame. */
const MIN_NCC = 0.9;
/** Differences below this (L2 of unit vectors, NCC > 0.99995) never separate two source frames. */
const SAME_DIST = 0.01;
/**
 * A new source moment starts only where consecutive source frames differ by at least this many times
 * the typical field-to-source residual: then a field cannot be mistaken for the other side. Smaller
 * differences (repeated frames, coding noise, motion too subtle to resolve) stay inside one moment,
 * so no precision is invented that the pictures do not have.
 */
const CLEAR_FACTOR = 3;
/** A multi-frame moment has a precise start only if the strategy shows every source frame (rate <= capacity). */
const RATE_TOLERANCE = 1.01;
/**
 * Least picture structure (8-bit luma levels) that a 64x48 line set needs to be timing evidence: the
 * spatially coherent part (lag-1 autocovariance, to which uncorrelated grain and rounding add nothing).
 * Below 3x the 8-bit rounding noise (3 x 0.29 = 0.87 levels) even an exact copy of the picture cannot
 * reach MIN_NCC. Measured (Beta Hardening, BH-H1): black, white and flat 0; near-black noise and grain
 * 0.1-0.8 (only grain too heavy for the encoder reaches 1.5); desaturated testsrc2 at 1/40 contrast 1.7,
 * dark + grain 1.4-1.5; a small title card 3.0; gradients 7+; every regression sample 56+.
 */
export const MIN_STRUCTURE = 1;

/**
 * Distinct source moments per second the strategy can deliver (a DVD property, not the generator's
 * mapping). Passing whole frames through carries what the frames hold: two moments each when the source
 * is interlaced (M-5).
 */
export function temporalCapacity(strategy: FrameRateStrategyId, interlacedSource = false): number {
  switch (strategy) {
    case 'interlace-60i':
      return 60000 / 1001; // one moment per field
    case 'telecine-3-2':
      return 24000 / 1001; // film frames spread over 3:2 fields
    case 'passthrough-29.97':
    case 'decimate-30':
      return interlacedSource ? 60000 / 1001 : 30000 / 1001;
    case 'progressive-29.97':
      return 30000 / 1001; // both fields from one moment
  }
}

/**
 * Whether the source's frames are interlaced (their two fields are different moments), from the first
 * decoded frames' own flags. The verifier's own probe; the analysis decides the same thing separately.
 */
export async function isInterlacedSource(tc: Toolchain, file: string, videoIndex: number, signal?: AbortSignal): Promise<boolean> {
  const r = await runTool(tc.ffprobe, ['-v', 'error', '-select_streams', String(videoIndex), '-read_intervals', '%+#30',
    '-show_entries', 'frame=interlaced_frame', '-of', 'csv=p=0', file], { errorCode: 'VERIFY_ERROR', signal });
  const flags = r.stdout.split('\n').map((l) => l.split(',')[0]).filter((x) => x === '0' || x === '1');
  return flags.length > 0 && 2 * flags.filter((x) => x === '1').length > flags.length;
}

/**
 * A decoded picture as its two line sets (zero-mean, unit-norm 64x48 luma each), or null for a line set
 * with too little structure to tell pictures apart (see normalise()): not evidence either way.
 */
export interface FieldPair {
  /** Seconds on the shared timeline (file origin removed). */
  t: number;
  /** Frame duration (seconds): the second field is displayed half of it later. */
  duration: number;
  /** Field shown first: 'top' unless the frame is flagged bottom field first. */
  first: 'top' | 'bottom';
  top: Float32Array | null;
  bottom: Float32Array | null;
  /**
   * Source frames: until when the picture is shown (seconds, same timeline), see displayEnd(). A VFR
   * frame can stay on screen long after its timestamp (BH-H2). Missing: a point at `t`.
   */
  end?: number;
}

/**
 * Time from `t` to a source picture's display interval [t, end]: 0 while it is shown. Distances to
 * source frames are always measured this way, so a held frame is near for as long as it is held.
 */
const gap = (s: FieldPair, t: number) => Math.max(0, s.t - t, t - (s.end ?? s.t));

/**
 * When a decoded frame stops being shown: the next decoded frame's time; for the last one decoded, its
 * own duration (the container's sample duration). Timestamps that do not increase, or a duration that
 * is missing or not positive, give no interval (the frame is a point), so broken timing never becomes
 * a long hold.
 */
export function displayEnd(t: number, next: number | undefined, duration: number | null): number {
  if (next !== undefined) return next > t ? next : t;
  return duration !== null && duration > 0 ? t + duration : t;
}

export interface OutputField {
  t: number;
  parity: 'top' | 'bottom';
  px: Float32Array | null;
}

/** Output frames -> fields in display order. */
export function displayFields(frames: FieldPair[]): OutputField[] {
  return frames.flatMap((f) => {
    const second = f.first === 'top' ? 'bottom' : 'top';
    return [
      { t: f.t, parity: f.first, px: f[f.first] },
      { t: f.t + f.duration / 2, parity: second, px: f[second] },
    ];
  });
}

export interface FieldStats {
  /** Output fields compared, and those that matched a source frame. */
  fields: number;
  matchedFields: number;
  /** Median distance of matched fields to their source frame (the comparison's noise level). */
  residual: number;
  /** Distinct source moments in the measured interval, and those clear enough to judge. */
  allMoments: number;
  sourceMoments: number;
  /** Of the clear moments, how many a correct conversion must show (capped by the capacity) and how many were shown. */
  expected: number;
  shown: number;
  /** Consecutive fields on clear moments that change moment, and those that go back in time. */
  steps: number;
  backwards: number;
  /** Fields whose picture is found only outside the search (see WIDE_SEARCH_SEC). */
  displaced: number;
}

export const emptyFieldStats = (): FieldStats => ({ fields: 0, matchedFields: 0, residual: 0, allMoments: 0, sourceMoments: 0, expected: 0, shown: 0, steps: 0, backwards: 0, displaced: 0 });

export function addFieldStats(a: FieldStats, b: FieldStats): FieldStats {
  const matched = a.matchedFields + b.matchedFields;
  return {
    fields: a.fields + b.fields,
    matchedFields: matched,
    residual: matched ? (a.residual * a.matchedFields + b.residual * b.matchedFields) / matched : 0,
    allMoments: a.allMoments + b.allMoments,
    sourceMoments: a.sourceMoments + b.sourceMoments,
    expected: a.expected + b.expected,
    shown: a.shown + b.shown,
    steps: a.steps + b.steps,
    backwards: a.backwards + b.backwards,
    displaced: a.displaced + b.displaced,
  };
}

function ncc(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < PIXELS; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

/** Euclidean distance between unit vectors. */
const dist = (a: Float32Array, b: Float32Array) => Math.sqrt(Math.max(0, 2 - 2 * ncc(a, b)));

/** Where the output first shows a source moment (display time) and where that moment starts in the source. */
export interface ChangePoint {
  out: number;
  src: number;
}

/** Where the output first shows a picture that repeats in the source, and every start of that picture nearby. */
export interface AmbiguousChangePoint {
  out: number;
  src: number[];
}

export interface FieldAnalysis {
  stats: FieldStats;
  /** Change points of clear moments that the output enters cleanly (for picture timing). */
  changes: ChangePoint[];
  /** Output minus source time of each displaced field (seconds; positive = picture late). */
  displaced: number[];
  /** Entries into pictures that repeat within the search (M-2): no one time, only candidates. */
  ambiguous: AmbiguousChangePoint[];
}

/**
 * Compare output fields with source frames. Moments are counted over [from, to) on the source timeline;
 * `fields` should cover that interval with some margin.
 */
export function analyseFields(source: FieldPair[], fields: OutputField[], from: number, to: number, capacityHz: number): FieldAnalysis {
  // Each field shows the most similar same-parity source picture nearby (if it is similar at all).
  const stats = emptyFieldStats();
  const bestFrame: (number | null)[] = [];
  const residuals: number[] = [];
  const displaced: number[] = [];
  for (const f of fields) {
    // A field without structure (black, flat) shows nothing that could be timed: not counted either way.
    if (!f.px) {
      bestFrame.push(null);
      continue;
    }
    stats.fields++;
    let best = -1;
    let bestScore = -Infinity;
    let wide = -1;
    let wideScore = -Infinity;
    for (let i = 0; i < source.length; i++) {
      const s = source[i];
      const px = s?.[f.parity];
      const dt = s ? gap(s, f.t) : Infinity;
      if (!s || !px || dt > WIDE_SEARCH_SEC) continue;
      const score = ncc(f.px, px);
      if (score > wideScore) {
        wideScore = score;
        wide = i;
      }
      if (dt <= SEARCH_SEC && score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    // Displaced: the picture is found outside the search, and everything inside it is clearly another
    // picture (the same test that separates moments).
    const near = best < 0 ? Infinity : Math.sqrt(Math.max(0, 2 - 2 * bestScore));
    const far = source[wide];
    if (far && gap(far, f.t) > SEARCH_SEC && wideScore >= MIN_NCC && near >= Math.max(SAME_DIST, CLEAR_FACTOR * Math.sqrt(Math.max(0, 2 - 2 * wideScore)))) {
      stats.displaced++;
      displaced.push(f.t - far.t);
    }
    if (best < 0 || bestScore < MIN_NCC) {
      bestFrame.push(null);
      continue;
    }
    stats.matchedFields++;
    residuals.push(Math.sqrt(Math.max(0, 2 - 2 * bestScore)));
    bestFrame.push(best);
  }
  residuals.sort((a, b) => a - b);
  const residual = residuals[residuals.length >> 1] ?? 0;
  stats.residual = residual;

  // Moments: a new one starts only at a clear change (both line sets), so repeats and unresolvable
  // differences never split a moment. first[k] / last[k] are the moment's frame indices. Frames without
  // structure belong to no moment; the pictures on either side of them are compared with each other.
  const boundary = Math.max(SAME_DIST, CLEAR_FACTOR * residual);
  const momentOf: (number | null)[] = [];
  const first: number[] = [];
  const last: number[] = [];
  let previous: FieldPair | null = null;
  let informativeFrames = 0;
  source.forEach((s, i) => {
    if (!s.top || !s.bottom) {
      momentOf.push(null);
      return;
    }
    if (!previous?.top || !previous.bottom || Math.min(dist(s.top, previous.top), dist(s.bottom, previous.bottom)) >= boundary) first.push(i);
    const k = first.length - 1;
    momentOf.push(k);
    last[k] = i;
    previous = s;
    if (s.t >= from && s.t < to) informativeFrames++;
  });
  const matched = bestFrame.map((i) => (i === null ? null : (momentOf[i] ?? null)));

  // Clear moments: bounded by clear changes on both sides (not cut off by the decoded range).
  const inside = (k: number) => {
    const t = source[first[k] ?? -1]?.t;
    return t !== undefined && t >= from && t < to;
  };
  // Pictures that come back (M-2): a moment whose picture the source shows again, as another moment,
  // within the search cannot be placed in time by its picture. Which of the equal instances a field
  // matches is chance (the earliest won, and a correct 5 Hz flicker measured +200 ms).
  const same = (a: FieldPair, b: FieldPair) => !!(a.top && a.bottom && b.top && b.bottom) && Math.min(dist(a.top, b.top), dist(a.bottom, b.bottom)) < boundary;
  const repeats = new Map<number, Set<number>>();
  source.forEach((a, i) => {
    const ka = momentOf[i];
    for (let j = i + 1; ka != null && j < source.length && (source[j]?.t ?? Infinity) - a.t <= SEARCH_SEC; j++) {
      const kb = momentOf[j];
      if (kb == null || kb === ka || !same(a, source[j]!)) continue;
      for (const [x, y] of [[ka, kb], [kb, ka]] as const) repeats.set(x, (repeats.get(x) ?? new Set()).add(y));
    }
  });
  const bounded = (k: number) => (first[k] ?? 0) > 0 && (last[k] ?? Infinity) + 1 < source.length;
  const clear = (k: number) => residuals.length > 0 && bounded(k) && !repeats.has(k);
  const moments = first.map((_, k) => k).filter(inside);
  const clearMoments = moments.filter(clear);
  const isClear = new Set(clearMoments);

  const shown = new Set(matched.filter((m): m is number => m !== null));
  let before: number | null = null;
  for (const m of matched) {
    const current = m !== null && isClear.has(m) ? m : null;
    if (current !== null && before !== null && current !== before) {
      stats.steps++;
      if (current < before) stats.backwards++;
    }
    before = current;
  }

  // Change points. A moment of several frames starts precisely only if every source frame is shown;
  // when the strategy skips source frames, its first frame may be skipped and the start is unknown.
  const intervals = source.slice(1).map((s, i) => s.t - (source[i]?.t ?? 0)).sort((a, b) => a - b);
  const frameInterval = intervals[intervals.length >> 1] ?? 0;
  const everyFrameShown = frameInterval > 0 && 1 / frameInterval <= capacityHz * RATE_TOLERANCE;
  const changes: ChangePoint[] = [];
  for (const k of clearMoments) {
    if (!everyFrameShown && (last[k] ?? 0) > (first[k] ?? 0)) continue;
    const j = matched.indexOf(k);
    const before = j > 0 ? matched[j - 1] : null;
    // The output must enter the moment from an earlier one, field to field; otherwise the entry is unclear.
    if (j <= 0 || before === null || before === undefined || before >= k) continue;
    const field = fields[j];
    const src = source[first[k] ?? -1];
    if (field && src) changes.push({ out: field.t, src: src.t });
  }
  // Entries into repeating pictures: the output changes to such a picture; every start of it nearby is a
  // candidate time. They can show that no candidate fits, never that one does (sync.ts).
  const ambiguous: AmbiguousChangePoint[] = [];
  const start = (k: number) => source[first[k] ?? -1]?.t;
  matched.forEach((m, j) => {
    const p = j > 0 ? matched[j - 1] : null;
    const alike = m != null ? repeats.get(m) : undefined;
    if (m == null || p == null || !alike || p === m || alike.has(p) || !inside(m) || !bounded(m) || residuals.length === 0) return;
    if (!everyFrameShown && (last[m] ?? 0) > (first[m] ?? 0)) return;
    const a = source[first[m] ?? -1];
    const b = source[first[p] ?? -1];
    if (!a || !b || same(a, b)) return; // not a change of picture
    const field = fields[j];
    const candidates = [m, ...alike].map(start).filter((t): t is number => t !== undefined);
    if (field) ambiguous.push({ out: field.t, src: candidates });
  });

  stats.allMoments = moments.length;
  stats.sourceMoments = clearMoments.length;
  // When the source has more moments than the strategy can carry, a correct output shows that share
  // (of the time that has pictures with structure).
  const framesInside = source.filter((s) => s.t >= from && s.t < to).length;
  const span = framesInside > 0 ? (to - from) * informativeFrames / framesInside : 0;
  const share = moments.length > 0 ? Math.min(1, capacityHz * span / moments.length) : 0;
  stats.expected = clearMoments.length * share;
  stats.shown = clearMoments.filter((k) => shown.has(k)).length;
  return { stats, changes, displaced, ambiguous };
}

/**
 * Pictures shown more than the search away from their source time (M-3): in some window, at least
 * MIN_WINDOW_MOMENTS fields and half of its fields with structure are displaced. Without this such an
 * output matched nothing nearby and was only "unmeasurable". Offset: median, milliseconds.
 */
export function judgeDisplacement(windows: FieldStats[], offsets: number[]): { offsetMs: number; fields: number; of: number } | null {
  if (!windows.some((w) => w.displaced >= MIN_WINDOW_MOMENTS && 2 * w.displaced >= w.fields)) return null;
  const sorted = [...offsets].sort((a, b) => a - b);
  return {
    offsetMs: Math.round((sorted[sorted.length >> 1] ?? 0) * 10000) / 10,
    fields: windows.reduce((n, w) => n + w.displaced, 0),
    of: windows.reduce((n, w) => n + w.fields, 0),
  };
}

export type FieldTemporalStatus = 'passed' | 'failed' | 'unmeasurable';

export interface FieldTemporalResult {
  status: FieldTemporalStatus;
  capacityHz: number;
  /** Shown / expected distinct source moments (1 = every moment the strategy can carry reached a field). */
  coverage: number | null;
  /** Share of moment changes between consecutive fields that go back in time (field order). */
  backwardRatio: number | null;
  /** The worst single window with enough evidence of its own (a local fault is not averaged away). */
  worstWindow: { coverage: number | null; backwardRatio: number | null; judged: number };
  stats: FieldStats;
  reason: string;
}

/** Fewer clear source moments than this (about a second of motion over all windows) cannot be judged. */
export const MIN_FIELD_MOMENTS = 24;
/** At least this share of fields must match a source frame for the comparison to mean anything. */
export const MIN_MATCHED_FIELDS = 0.5;
/**
 * Lowest acceptable coverage and highest acceptable backward share (docs/core.md §7). Losing every
 * other field gives a coverage of 0.5; swapped field order gives a backward share of 0.5.
 */
export const MIN_FIELD_COVERAGE = 0.8;
export const MAX_BACKWARD_RATIO = 0.1;
/** A single window is judged on its own when it expects at least this many moments (or field steps). */
export const MIN_WINDOW_MOMENTS = 12;

const ratio = (a: number, b: number) => Math.min(1, Math.round(a / b * 1000) / 1000);

/**
 * `windows`: the per-window statistics summed into `stats`. The verdict needs both the whole and every
 * window with enough evidence to pass: a fault confined to one sampled window is not diluted by the
 * others (Phase 5.2).
 */
export function judgeFields(stats: FieldStats, capacityHz: number, windows: FieldStats[] = []): FieldTemporalResult {
  const coverages = windows.filter((w) => w.expected >= MIN_WINDOW_MOMENTS).map((w) => ratio(w.shown, w.expected));
  const backwards = windows.filter((w) => w.steps >= MIN_WINDOW_MOMENTS).map((w) => ratio(w.backwards, w.steps));
  const worstWindow = {
    coverage: coverages.length ? Math.min(...coverages) : null,
    backwardRatio: backwards.length ? Math.max(...backwards) : null,
    judged: Math.max(coverages.length, backwards.length),
  };
  const base = { capacityHz, stats, worstWindow };
  if (stats.fields === 0 || stats.matchedFields / stats.fields < MIN_MATCHED_FIELDS) {
    return { ...base, status: 'unmeasurable', coverage: null, backwardRatio: null, reason: `not measurable: ${stats.matchedFields}/${stats.fields} fields matched the source` };
  }
  if (stats.sourceMoments < MIN_FIELD_MOMENTS || stats.expected < MIN_FIELD_MOMENTS / 2) {
    return { ...base, status: 'unmeasurable', coverage: null, backwardRatio: null, reason: `not measurable: ${stats.sourceMoments} clearly distinct source moments (still or slow picture)` };
  }
  const coverage = ratio(stats.shown, stats.expected);
  const backwardRatio = stats.steps ? ratio(stats.backwards, stats.steps) : 0;
  const ok = coverage >= MIN_FIELD_COVERAGE && backwardRatio <= MAX_BACKWARD_RATIO &&
    (worstWindow.coverage ?? 1) >= MIN_FIELD_COVERAGE && (worstWindow.backwardRatio ?? 0) <= MAX_BACKWARD_RATIO;
  return {
    ...base,
    status: ok ? 'passed' : 'failed',
    coverage,
    backwardRatio,
    reason: `${stats.shown} of ${Math.round(stats.expected)} expected source moments reached a field (coverage ${coverage}, up to ${capacityHz.toFixed(3)}/s), ` +
      `${stats.backwards}/${stats.steps} field steps backwards; worst of ${worstWindow.judged} windows: coverage ${worstWindow.coverage ?? '-'}, backwards ${worstWindow.backwardRatio ?? '-'}`,
  };
}

/**
 * A line set as a zero-mean unit vector, or null when it has less structure than MIN_STRUCTURE: then
 * normalising would only amplify rounding and grain (black gives a zero vector, near-black noise a
 * random one, and either looks like a new picture every frame). Such a line set is no evidence either
 * way: it starts no moment and is not counted as a matched or unmatched field.
 */
export function normalise(raw: Buffer, offset: number): Float32Array | null {
  const px = new Float32Array(PIXELS);
  let mean = 0;
  for (let i = 0; i < PIXELS; i++) mean += raw[offset + i] ?? 0;
  mean /= PIXELS;
  let norm = 0;
  for (let i = 0; i < PIXELS; i++) {
    const v = (raw[offset + i] ?? 0) - mean;
    px[i] = v;
    norm += v * v;
  }
  let coherent = 0;
  let pairs = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = px[y * W + x] ?? 0;
      if (x + 1 < W) coherent += v * (px[y * W + x + 1] ?? 0);
      if (y + 1 < H) coherent += v * (px[(y + 1) * W + x] ?? 0);
      pairs += (x + 1 < W ? 1 : 0) + (y + 1 < H ? 1 : 0);
    }
  }
  if (Math.sqrt(Math.max(0, coherent / pairs)) < MIN_STRUCTURE) return null;
  norm = Math.sqrt(norm);
  for (let i = 0; i < PIXELS; i++) px[i] = (px[i] ?? 0) / norm;
  return px;
}

/**
 * Decode pictures in [start, start+duration) (seconds from the file origin) as top/bottom line sets.
 * `prefix` brings the picture to the active area's lines, 64 columns wide (scale for the source, crop for the output).
 */
async function decodeFieldPairs(tc: Toolchain, input: string, origin: number, map: string, start: number, duration: number, prefix: string, signal?: AbortSignal): Promise<FieldPair[]> {
  const info: { t: number; duration: number; reported: number | null; first: 'top' | 'bottom' }[] = [];
  const vf = `${prefix},showinfo,split[a][b];[a]field=top,scale=${W}:${H}:flags=area[t];[b]field=bottom,scale=${W}:${H}:flags=area[u];[t][u]vstack,format=gray`;
  // Read only the window (input -t counts from the seek point), not a fixed number of frames.
  const seek = Math.max(0, start - 0.5);
  const r = await runTool(tc.ffmpeg, [
    '-hide_banner', '-nostdin', '-v', 'info', '-copyts', '-ss', seek.toFixed(4), '-t', (start + duration - seek + 0.1).toFixed(4), '-i', input,
    '-map', map, '-vf', vf, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-',
  ], {
    errorCode: 'VERIFY_ERROR',
    signal,
    binary: true,
    onStderrLine: (line) => {
      if (!/Parsed_showinfo/.test(line)) return;
      const t = /pts_time:\s*(-?[\d.]+)/.exec(line)?.[1];
      if (t === undefined) return;
      const reported = Number(/duration_time:\s*([\d.]+)/.exec(line)?.[1] ?? NaN);
      const d = Number.isFinite(reported) && reported > 0 ? reported : null;
      info.push({ t: Number(t), duration: d ?? 1001 / 30000, reported: d, first: /\bi:B\b/.test(line) ? 'bottom' : 'top' });
    },
  });
  const buf = r.stdoutBuffer;
  const out: FieldPair[] = [];
  for (let i = 0; (i + 1) * 2 * PIXELS <= buf.length && i < info.length; i++) {
    const m = info[i]!;
    const t = m.t - origin;
    if (t >= start && t < start + duration) {
      const end = displayEnd(m.t, info[i + 1]?.t, m.reported) - origin;
      out.push({ t, duration: m.duration, first: m.first, top: normalise(buf, i * 2 * PIXELS), bottom: normalise(buf, i * 2 * PIXELS + PIXELS), end });
    }
  }
  return out;
}

export interface FieldMeasureInput {
  toolchain: Toolchain;
  /** interlaced: compare with the source's fields, each at its own time (isInterlacedSource). */
  source: { path: string; origin: number; videoIndex: number; duration: number; colorMatrix: 'bt709' | 'bt601'; interlaced: boolean };
  output: { input: string; origin: number; active: ActiveArea };
  /** Window centres (seconds), the same deterministic positions as the sync measurement. */
  windows: number[];
  capacityHz: number;
  signal?: AbortSignal;
}

export async function measureFields(input: FieldMeasureInput): Promise<FieldAnalysis & { windows: FieldStats[] }> {
  const { toolchain: tc, source, output, signal } = input;
  const a = output.active;
  // The source is brought to the active area in its own step: a single 1920 -> 64 area scale (with the
  // colour conversion) blurred fine detail differently from the output and hid the motion. Then both
  // sides are narrowed to 64 columns; the lines, and so the field parity, stay.
  const fields = source.interlaced ? 'separatefields,' : '';
  const sourcePrefix = `${fields}scale=${a.width}:${a.height}:flags=area:in_color_matrix=${source.colorMatrix}:out_color_matrix=bt601,scale=${W}:${a.height}:flags=area`;
  const outputPrefix = `crop=${a.width}:${a.height}:${a.x}:${a.y},scale=${W}:${a.height}:flags=area`;
  let stats = emptyFieldStats();
  const changes: ChangePoint[] = [];
  const displaced: number[] = [];
  const ambiguous: AmbiguousChangePoint[] = [];
  const windows: FieldStats[] = [];
  for (const centre of input.windows) {
    const outStart = Math.max(0, centre - WINDOW_SEC / 2);
    const srcStart = Math.max(0, outStart - SOURCE_MARGIN_SEC);
    const src = await decodeFieldPairs(tc, source.path, source.origin, `0:${source.videoIndex}`, srcStart, WINDOW_SEC + 2 * SOURCE_MARGIN_SEC, sourcePrefix, signal);
    const out = await decodeFieldPairs(tc, output.input, output.origin, '0:v:0', outStart, WINDOW_SEC, outputPrefix, signal);
    const end = Math.min(outStart + WINDOW_SEC, source.duration);
    const window = analyseFields(src, displayFields(out), outStart + EDGE_SEC, end - EDGE_SEC, input.capacityHz);
    stats = addFieldStats(stats, window.stats);
    windows.push(window.stats);
    changes.push(...window.changes);
    displaced.push(...window.displaced);
    ambiguous.push(...window.ambiguous);
  }
  return { stats, changes, displaced, ambiguous, windows };
}
