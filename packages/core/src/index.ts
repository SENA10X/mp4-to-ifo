// Public API of the MP4 to IFO conversion core. GUI and CLI use only this module.

export { analyzeInput, type AudioTrack, type HdrInfo, type InputAnalysis, type SubtitleTrack, type VideoInfo } from './analyze.ts';
export { planConversion, planDigest, type ConversionPlan, type PlanIssue, type PlanIssueCode, type PlanOptions } from './plan.ts';
export {
  analyzeAndPlan, cleanupStaleJobs, convert, defaultTempRoot, nextOutputDirectory,
  type ConversionPhase, type ConversionResult, type ConvertOptions, type ProgressEvent,
} from './job.ts';
export {
  verifyOutput, AUDIO_TIMING_TOLERANCE_MS, DURATION_TOLERANCE_S, SYNC_TOLERANCE_MS,
  type CheckStatus, type VerificationCheck, type VerificationReport,
} from './verify/index.ts';
export { ConversionError, ERROR_CODES, exitCodeFor, isCancelled, type ErrorCode } from './errors.ts';
export { createErrorReport, redact, type ErrorReport, type LogEvent, type LogSink } from './log.ts';
export { inspectToolchain, resolveToolchain, type Toolchain, type ToolchainReport } from './toolchain.ts';
export { defaultPlatform, macosPlatform, nullPlatform, type PlatformAdapter } from './platform.ts';
export { acquireLock, defaultLockDir, type ConversionLock } from './lock.ts';
export { INTERLACED_POLICY, PROGRESSIVE_POLICY, type FrameRatePolicy, type FrameRateStrategyId } from './profile/frame-rate.ts';
export { LOW_VIDEO_KBPS, MIN_VIDEO_KBPS, TARGET_USABLE_BYTES, videoBitrateKbps } from './capacity.ts';
