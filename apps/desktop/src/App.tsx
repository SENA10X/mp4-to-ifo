// App shell: holds the flow state, connects the bridge (engine, drops, quit requests) and language.

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { Bridge } from './bridge.ts';
import { config } from './config.ts';
import { initialState, reduce } from './flow.ts';
import { I18nContext, loadLanguage, saveLanguage, translate, type Language } from './i18n/index.ts';
import { Analyzing, Complete, Converting, Failed, Home, Plan, Settings } from './screens.tsx';

const basename = (p: string) => p.split('/').pop() ?? p;

export function App(props: { bridge: Bridge; storage?: Storage; languages?: readonly string[] }) {
  const { bridge } = props;
  const [state, dispatch] = useReducer(reduce, initialState);
  const [language, setLanguage] = useState<Language>(() => loadLanguage(props.storage, props.languages ?? navigator.languages));
  const [settings, setSettings] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [version, setVersion] = useState('');
  const i18n = useMemo(() => ({ language, t: (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => translate(language, key, params) }), [language]);
  const stateRef = useRef(state);
  stateRef.current = state;
  const t = i18n.t;

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  useEffect(() => {
    void bridge.appVersion().then(setVersion);
  }, [bridge]);

  // Engine events (progress, result, error, exit) and window close / Cmd+Q while converting.
  useEffect(() => {
    const unlisten: Promise<() => void>[] = [
      bridge.onEngine((message) => {
        if (message.type === 'exit') dispatch({ type: 'engineExit', code: message.code });
        else dispatch({ type: 'engine', message });
      }),
      bridge.onQuitRequested(() => {
        void bridge.ask({ title: t('quit.title'), message: t('quit.body'), ok: t('quit.confirm'), cancel: t('quit.keep') }).then((quit) => {
          if (quit) void bridge.cancelAndQuit();
        });
      }),
      bridge.onDragDrop((e) => {
        if (e.type === 'enter') setDragging(true);
        else if (e.type === 'leave') setDragging(false);
        else if (e.type === 'drop') {
          setDragging(false);
          dispatch({ type: 'files', paths: e.paths });
        }
      }),
    ];
    return () => unlisten.forEach((u) => void u.then((f) => f()));
  }, [bridge, t]);

  // Analyze whenever a file was accepted.
  useEffect(() => {
    if (state.screen !== 'analyzing') return;
    void bridge.analyze(state.input, null).then((message) => dispatch({ type: 'analyzed', message }));
  }, [bridge, state]);

  // Notify on completion or failure (the bridge skips it while the window is focused).
  const lastScreen = useRef(state.screen);
  useEffect(() => {
    const was = lastScreen.current;
    lastScreen.current = state.screen;
    if (was !== 'converting') return;
    if (state.screen === 'complete') void bridge.notify(t('notify.done.title'), t('notify.done.body', { name: basename(state.input) }));
    if (state.screen === 'failed' && state.error.code !== 'CANCELLED') {
      void bridge.notify(t('notify.failed.title'), t('notify.failed.body', { name: basename(state.input ?? '') }));
    }
  }, [bridge, state, t]);

  // Cmd+, opens Settings.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === ',') {
        e.preventDefault();
        setSettings(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const selectFile = useCallback(async () => {
    const path = await bridge.pickMp4(t('home.select'));
    if (path) dispatch({ type: 'files', paths: [path] });
  }, [bridge, t]);

  const changeOutput = useCallback(async () => {
    const s = stateRef.current;
    if (s.screen !== 'plan') return;
    const dir = await bridge.pickFolder(s.data.plan.output.directory);
    if (!dir) return;
    // The core plans again for the new folder and decides the name (name, name-2, …).
    dispatch({ type: 'replanned', message: await bridge.analyze(s.input, dir) });
  }, [bridge]);

  const convert = useCallback(async () => {
    const s = stateRef.current;
    if (s.screen !== 'plan') return;
    dispatch({ type: 'convert' });
    await bridge.startConversion(s.input, s.data.plan.output.directory, s.data.planDigest).catch((error: unknown) => {
      dispatch({ type: 'engine', message: { type: 'error', error: { code: 'INTERNAL_ERROR', reason: null, planErrors: [], report: { code: 'INTERNAL_ERROR', reason: null, message: String(error), detail: null, exitCode: null, phase: null, app: {} } } } });
    });
  }, [bridge]);

  const cancel = useCallback(async () => {
    const confirmed = await bridge.ask({ title: t('cancel.title'), message: t('cancel.body'), ok: t('cancel.confirm'), cancel: t('cancel.keep') });
    if (confirmed && stateRef.current.screen === 'converting') {
      dispatch({ type: 'cancelRequested' });
      await bridge.cancel();
    }
  }, [bridge, t]);

  const changeLanguage = (next: Language) => {
    setLanguage(next);
    saveLanguage(props.storage, next);
  };

  let screen: React.ReactNode;
  switch (state.screen) {
    case 'home':
      screen = <Home notice={state.notice} dragging={dragging} onSelect={() => void selectFile()} />;
      break;
    case 'analyzing':
      screen = <Analyzing />;
      break;
    case 'plan':
      screen = <Plan data={state.data} onConvert={() => void convert()} onChangeOutput={() => void changeOutput()} onAnother={() => dispatch({ type: 'reset' })} />;
      break;
    case 'converting':
      screen = <Converting progress={state.progress} cancelling={state.cancelling} onCancel={() => void cancel()} />;
      break;
    case 'complete':
      screen = (
        <Complete
          outputDir={state.outputDir}
          isoFileName={state.isoFileName}
          notMeasured={state.notMeasured}
          onOpen={() => void bridge.openFolder(state.outputDir)}
          onGuide={() => config.burnGuideUrl && void bridge.openUrl(config.burnGuideUrl)}
          onAnother={() => dispatch({ type: 'reset' })}
        />
      );
      break;
    case 'failed':
      screen = (
        <Failed
          error={state.error}
          onCopy={() => bridge.copy(JSON.stringify(state.error.report, null, 2))}
          onAnother={() => dispatch({ type: 'reset' })}
          onReport={() => config.reportIssueUrl && void bridge.openUrl(config.reportIssueUrl)}
        />
      );
      break;
  }

  return (
    <I18nContext.Provider value={i18n}>
      <main className={dragging && state.screen === 'home' ? 'dragging' : undefined}>
        {state.screen !== 'converting' && (
          <button type="button" className="settings-button" onClick={() => setSettings(true)} aria-label={t('settings')} title={t('settings')}>
            {t('settings')}
          </button>
        )}
        {screen}
      </main>
      {settings && (
        <Settings language={language} version={version} onLanguage={changeLanguage} onLicenses={() => bridge.readLicenses()} onClose={() => setSettings(false)} />
      )}
    </I18nContext.Provider>
  );
}

