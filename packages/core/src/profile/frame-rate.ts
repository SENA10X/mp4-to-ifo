// Frame-rate strategy (docs/poc.md §9.3–9.7). A policy maps the input rate to one strategy; policies
// are swappable so 59.94i can be replaced by 29.97p without touching the rest of the pipeline.
//
// Every strategy pins its fps grid to the source timeline origin (start_time=0). Without it the grid
// starts at the first video timestamp; a source whose video starts one 59.94 slot late (the VFR sample
// starts at 16 ms) then pairs fields one slot off and plays one field (17 ms) late.

export type FrameRateClass = 'ntsc-29.97' | 'ntsc-30' | 'film' | 'video-60' | 'pal-50' | 'pal-25' | 'other' | 'variable';

export type FrameRateStrategyId = 'passthrough-29.97' | 'decimate-30' | 'telecine-3-2' | 'interlace-60i' | 'progressive-29.97';

export interface FrameRateDecision {
  inputClass: FrameRateClass;
  strategy: FrameRateStrategyId;
  /** ffmpeg filter chain producing 29.97 frames/s. */
  filter: string;
  /** True when the two fields of an output frame can come from different moments. */
  fieldBased: boolean;
}

export interface FrameRatePolicy {
  readonly name: string;
  decide(inputClass: FrameRateClass): FrameRateDecision;
}

const near = (value: number, target: number) => Math.abs(value - target) < 0.01;

export function classifyFrameRate(frameRate: number, isVariableFrameRate: boolean): FrameRateClass {
  if (isVariableFrameRate) return 'variable';
  if (near(frameRate, 30000 / 1001)) return 'ntsc-29.97';
  if (near(frameRate, 30)) return 'ntsc-30';
  if (near(frameRate, 24000 / 1001) || near(frameRate, 24)) return 'film';
  if (near(frameRate, 60000 / 1001) || near(frameRate, 60)) return 'video-60';
  if (near(frameRate, 50)) return 'pal-50';
  if (near(frameRate, 25)) return 'pal-25';
  return 'other';
}

/** 29.97 frames from the source timeline, whole frames only (both fields from one source frame). */
export const FILTER_PROGRESSIVE_2997 = 'fps=30000/1001:start_time=0';

/** 3:2 hard telecine from 23.976 (24 drops one frame in 1001). LGPL filters only. */
export const FILTER_TELECINE = 'fps=24000/1001:start_time=0,telecine=first_field=top:pattern=23';

/**
 * 59.94 fields: top field of frame 2n + bottom field of frame 2n+1. Bit-identical to the GPL-only
 * tinterlace=interleave_top. weave stamps each frame with its second field's time (+1/2 frame);
 * round=down puts it back on the first field's time (round=near delayed video by one frame, the
 * Phase 2 33 ms bug).
 */
export const FILTER_INTERLACE_60I =
  "fps=60000/1001:start_time=0,setfield=tff,separatefields,select='not(mod(n\\,4))+eq(mod(n\\,4)\\,3)'," +
  'weave=first_field=top,fps=30000/1001:round=down,setfield=tff';

function decision(inputClass: FrameRateClass, strategy: FrameRateStrategyId): FrameRateDecision {
  switch (strategy) {
    case 'passthrough-29.97':
    case 'decimate-30':
    case 'progressive-29.97':
      return { inputClass, strategy, filter: FILTER_PROGRESSIVE_2997, fieldBased: false };
    case 'telecine-3-2':
      return { inputClass, strategy, filter: FILTER_TELECINE, fieldBased: true };
    case 'interlace-60i':
      return { inputClass, strategy, filter: FILTER_INTERLACE_60I, fieldBased: true };
  }
}

/** Default (docs/poc.md §9.7): film -> telecine, everything that is not 29.97/30 -> 59.94i. */
export const INTERLACED_POLICY: FrameRatePolicy = {
  name: 'interlaced',
  decide(inputClass) {
    if (inputClass === 'ntsc-29.97') return decision(inputClass, 'passthrough-29.97');
    if (inputClass === 'ntsc-30') return decision(inputClass, 'decimate-30');
    if (inputClass === 'film') return decision(inputClass, 'telecine-3-2');
    return decision(inputClass, 'interlace-60i');
  },
};

/** Fallback if 59.94i fails on physical players: 59.94i inputs become whole-frame 29.97p. */
export const PROGRESSIVE_POLICY: FrameRatePolicy = {
  name: 'progressive',
  decide(inputClass) {
    if (inputClass === 'ntsc-29.97') return decision(inputClass, 'passthrough-29.97');
    if (inputClass === 'ntsc-30') return decision(inputClass, 'decimate-30');
    if (inputClass === 'film') return decision(inputClass, 'telecine-3-2');
    return decision(inputClass, 'progressive-29.97');
  },
};

const FRAME = 1001 / 30000;
const FIELD = FRAME / 2;
const FILM_FRAME = 1001 / 24000;
/** fps filter rounding (AV_ROUND_NEAR_INF: halves away from zero). */
const nearest = (x: number) => Math.sign(x) * Math.round(Math.abs(x));

/**
 * When a source moment at `sourceTime` (seconds on the timeline) first appears in the output, for a
 * correct conversion with this strategy. Verification compares measured display times against this,
 * so the inherent drift of 30 -> 29.97 or the 3:2 cadence is not mistaken for an A/V offset.
 */
export function expectedDisplayTime(strategy: FrameRateStrategyId, sourceTime: number): number {
  switch (strategy) {
    case 'passthrough-29.97':
    case 'decimate-30':
    case 'progressive-29.97':
      return nearest(sourceTime / FRAME) * FRAME;
    case 'interlace-60i':
      return nearest(sourceTime / FIELD) * FIELD;
    case 'telecine-3-2': {
      // pattern=23: each group of 4 film frames becomes 10 fields, starting at fields 0, 2, 5, 7.
      const j = nearest(sourceTime / FILM_FRAME);
      const group = Math.floor(j / 4);
      const start = [0, 2, 5, 7][((j % 4) + 4) % 4] ?? 0;
      return (group * 10 + start) * FIELD;
    }
  }
}
