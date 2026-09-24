// Engine data -> UI text keys. Presentation only; the decisions come from the core.

import type { MessageKey } from './i18n/index.ts';
import type { EngineError, PlanIssue } from './engine-types.ts';

export function errorMessage(error: EngineError): { key: MessageKey; params?: Record<string, string | number> } {
  const planError = error.planErrors[0];
  if (planError) return planIssueMessage(planError, 'planError');
  const byReason = `error.${error.reason ?? ''}` as MessageKey;
  const known: readonly string[] = [
    'TRUNCATED', 'UNREADABLE_MEDIA', 'UNDECODABLE', 'NOT_MP4', 'UNREADABLE', 'NOT_A_FILE', 'NO_VIDEO', 'PLAN_CHANGED',
    'LOCKED', 'TOOL_MISSING', 'TOOL_FEATURES', 'FFMPEG_LICENSE', 'DISK_SPACE', 'OUTPUT_NOT_WRITABLE',
  ];
  if (error.reason && known.includes(error.reason)) return { key: byReason };
  return { key: `error.${error.code}` as MessageKey };
}

export function planIssueMessage(issue: PlanIssue, kind: 'warning' | 'planError'): { key: MessageKey; params?: Record<string, string | number> } {
  const d = issue.data ?? {};
  const key = `${kind}.${issue.code}` as MessageKey;
  switch (issue.code) {
    case 'LOW_BITRATE':
      return { key, params: { kbps: Number(d.videoKbps).toLocaleString('en-US') } };
    case 'MULTIPLE_AUDIO_TRACKS':
      return { key, params: { tracks: Number(d.tracks), selected: Number(d.selected) + 1 } };
    default:
      return { key };
  }
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

export function formatFps(fps: number): string {
  if (Math.abs(fps - Math.round(fps)) < 0.005) return String(Math.round(fps));
  return fps.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

export function formatSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}
