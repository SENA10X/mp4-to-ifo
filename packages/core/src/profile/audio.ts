// Audio plan (docs/poc.md §9.8–9.11): AC-3 stereo 48 kHz 256 kbps, no loudness normalization.
// Only layouts verified in Phase 2 are handled; other layouts are rejected rather than guessed.

import type { AudioTrack } from '../analyze.ts';
import { AUDIO_KBPS } from '../capacity.ts';

export type AudioStrategy = 'stereo' | 'mono-to-stereo' | 'downmix-5.1' | 'silence';

export interface AudioPlan {
  strategy: AudioStrategy;
  /** ffprobe stream index of the source track, or null for silence. */
  sourceIndex: number | null;
  source: { codec: string; channels: number; channelLayout: string | null; sampleRate: number } | null;
  /** Channel matrix applied before the clip guard (ffmpeg filter), or null. */
  matrix: string | null;
  /** 5.1 only: attenuate (never boost) so the downmix sample peak stays at or below this. */
  clipGuardCeilingDbfs: number | null;
  codec: 'ac3';
  bitrateKbps: number;
  sampleRate: 48000;
  channels: 2;
}

export type AudioPlanResult = { ok: true; plan: AudioPlan } | { ok: false; reason: 'UNSUPPORTED_AUDIO_LAYOUT'; detail: string };

export const CLIP_GUARD_CEILING_DBFS = -1;

/** ITU-R BS.775 Lo/Ro: centre and surrounds at -3 dB, LFE omitted. */
export function downmixMatrix(layout: '5.1' | '5.1(side)'): string {
  const [ls, rs] = layout === '5.1' ? ['BL', 'BR'] : ['SL', 'SR'];
  return `pan=stereo|FL=FL+0.7071*FC+0.7071*${ls}|FR=FR+0.7071*FC+0.7071*${rs}`;
}

/** Explicit mono to stereo at unity (ffmpeg's -ac 2 would place mono at -3 dB). */
export const MONO_TO_STEREO = 'pan=stereo|c0=c0|c1=c0';

const base = { codec: 'ac3', bitrateKbps: AUDIO_KBPS, sampleRate: 48000, channels: 2 } as const;

export function planAudio(track: AudioTrack | null): AudioPlanResult {
  if (!track) {
    return { ok: true, plan: { ...base, strategy: 'silence', sourceIndex: null, source: null, matrix: null, clipGuardCeilingDbfs: null } };
  }
  const source = { codec: track.codec, channels: track.channels, channelLayout: track.channelLayout, sampleRate: track.sampleRate };
  const common = { ...base, sourceIndex: track.index, source };
  if (track.channels === 2) return { ok: true, plan: { ...common, strategy: 'stereo', matrix: null, clipGuardCeilingDbfs: null } };
  if (track.channels === 1) return { ok: true, plan: { ...common, strategy: 'mono-to-stereo', matrix: MONO_TO_STEREO, clipGuardCeilingDbfs: null } };
  if (track.channels === 6 && (track.channelLayout === '5.1' || track.channelLayout === '5.1(side)')) {
    return {
      ok: true,
      plan: { ...common, strategy: 'downmix-5.1', matrix: downmixMatrix(track.channelLayout), clipGuardCeilingDbfs: CLIP_GUARD_CEILING_DBFS },
    };
  }
  return { ok: false, reason: 'UNSUPPORTED_AUDIO_LAYOUT', detail: `${track.channels} channels, layout ${track.channelLayout ?? 'unknown'}` };
}

/** Static gain from the measured downmix peak: 0 when at or below the ceiling, otherwise attenuate. */
export function clipGuardGainDb(peakDbfs: number, ceilingDbfs = CLIP_GUARD_CEILING_DBFS): number {
  if (!Number.isFinite(peakDbfs) || peakDbfs <= ceilingDbfs) return 0;
  return Math.round((ceilingDbfs - peakDbfs) * 100) / 100;
}

/**
 * Full audio filter chain. The trailing aresample pads/trims the start to the timeline origin so
 * audio and video both start at 0.
 */
export function audioFilterChain(plan: AudioPlan, gainDb: number): string {
  const parts: string[] = [];
  if (plan.matrix) parts.push(plan.matrix);
  if (gainDb < 0) parts.push(`volume=${gainDb.toFixed(2)}dB`);
  parts.push('aresample=48000:async=1:first_pts=0');
  return parts.join(',');
}
