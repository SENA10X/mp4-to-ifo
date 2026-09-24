// Types of the engine's JSON messages (engine/engine.ts), shared with the UI. Type-only imports of the
// core: the UI never runs the core itself.

export type { EngineError, EngineMessage, AnalysisSummary, ResultSummary } from '../engine/engine.ts';
export type { ConversionPlan, PlanIssue, ProgressEvent, ErrorReport } from '@mp4-to-ifo/core';
