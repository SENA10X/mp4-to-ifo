// The app's single flow as a pure state machine: home -> analyzing -> plan -> converting -> complete,
// with error and cancel states. The UI renders the state; the engine (via the bridge) drives it.

import type { EngineError, EngineMessage, ProgressEvent } from './engine-types.ts';

export type PlanMessage = Extract<EngineMessage, { type: 'plan' }>;

export type State =
  | { screen: 'home'; notice: 'notMp4' | 'multiple' | null }
  | { screen: 'analyzing'; input: string }
  | { screen: 'plan'; input: string; data: PlanMessage }
  | { screen: 'converting'; input: string; data: PlanMessage; progress: ProgressEvent | null; cancelling: boolean }
  | { screen: 'complete'; input: string; outputDir: string; isoFileName: string; notMeasured: number }
  | { screen: 'failed'; input: string | null; error: EngineError };

export type Action =
  | { type: 'files'; paths: string[] }
  | { type: 'analyzed'; message: EngineMessage }
  /** A new plan for the same input (the output folder was changed). */
  | { type: 'replanned'; message: EngineMessage }
  | { type: 'convert' }
  | { type: 'engine'; message: EngineMessage }
  | { type: 'engineExit'; code: number | null }
  | { type: 'cancelRequested' }
  | { type: 'reset' };

export const initialState: State = { screen: 'home', notice: null };

const internal = (message: string): EngineError => ({
  code: 'INTERNAL_ERROR',
  reason: null,
  planErrors: [],
  report: { code: 'INTERNAL_ERROR', reason: null, message, detail: null, exitCode: null, phase: null, app: {} },
});

/** Only one MP4 at a time; the extension check is only a first filter (the core validates the file). */
export function pickInput(paths: string[]): { input: string } | { notice: 'notMp4' | 'multiple' } {
  if (paths.length !== 1) return { notice: 'multiple' };
  const [path] = paths;
  return path && /\.mp4$/i.test(path) ? { input: path } : { notice: 'notMp4' };
}

export function reduce(state: State, action: Action): State {
  switch (action.type) {
    case 'files': {
      if (state.screen !== 'home' && state.screen !== 'failed' && state.screen !== 'complete') return state;
      const picked = pickInput(action.paths);
      return 'input' in picked ? { screen: 'analyzing', input: picked.input } : { screen: 'home', notice: picked.notice };
    }
    case 'analyzed': {
      if (state.screen !== 'analyzing') return state;
      const m = action.message;
      if (m.type === 'plan') return { screen: 'plan', input: state.input, data: m };
      if (m.type === 'error') return { screen: 'failed', input: state.input, error: m.error };
      return { screen: 'failed', input: state.input, error: internal('unexpected engine reply') };
    }
    case 'replanned': {
      if (state.screen !== 'plan') return state;
      const m = action.message;
      if (m.type === 'plan') return { ...state, data: m };
      if (m.type === 'error') return { screen: 'failed', input: state.input, error: m.error };
      return state;
    }
    case 'convert':
      if (state.screen !== 'plan' || state.data.plan.errors.length) return state;
      return { screen: 'converting', input: state.input, data: state.data, progress: null, cancelling: false };
    case 'engine': {
      if (state.screen !== 'converting') return state;
      const m = action.message;
      if (m.type === 'progress') return { ...state, progress: m.event };
      if (m.type === 'done') {
        return { screen: 'complete', input: state.input, outputDir: m.result.outputDir, isoFileName: m.result.isoFileName, notMeasured: m.result.notMeasured };
      }
      if (m.type === 'error') return { screen: 'failed', input: state.input, error: m.error };
      return state;
    }
    case 'engineExit':
      // The engine ended without a result (crashed or was killed).
      if (state.screen !== 'converting') return state;
      return { screen: 'failed', input: state.input, error: internal(`engine exited (${action.code ?? 'signal'})`) };
    case 'cancelRequested':
      return state.screen === 'converting' ? { ...state, cancelling: true } : state;
    case 'reset':
      return initialState;
  }
}
