// UI logic and screens without a browser: the flow reducer, the screens rendered to markup in both
// languages, i18n, message mapping and the stylesheet. The engine and toolchain are tested in test/engine.

import fs from 'node:fs';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, expectTypeOf, test, vi } from 'vitest';
import { App } from '../../src/App.tsx';
import { tauriBridge, type Bridge } from '../../src/bridge.ts';
import { config } from '../../src/config.ts';
import type { EngineError, EngineMessage, PlanIssue, ProgressEvent } from '../../src/engine-types.ts';
import { initialState, pickInput, reduce, type PlanMessage, type State } from '../../src/flow.ts';
import { en } from '../../src/i18n/en.ts';
import { I18nContext, loadLanguage, saveLanguage, systemLanguage, translate, type Language, type MessageKey } from '../../src/i18n/index.ts';
import { ja } from '../../src/i18n/ja.ts';
import { errorMessage, formatDuration, formatFps, formatSize } from '../../src/messages.ts';
import { Analyzing, Complete, Converting, Failed, Home, Plan, Settings } from '../../src/screens.tsx';
import fixture from './plan.fixture.json';

const invoke = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => {}));
vi.mock('@tauri-apps/api/core', async (original) => ({ ...(await original<object>()), invoke }));

const planMessage = fixture as unknown as PlanMessage;
const input = '/Users/me/Movies/standard-16x9.mp4';
const noop = () => {};

function withPlan(change: { warnings?: PlanIssue[]; errors?: PlanIssue[] }): PlanMessage {
  return { ...planMessage, plan: { ...planMessage.plan, warnings: change.warnings ?? [], errors: change.errors ?? [] } };
}

function engineError(code: string, reason: string | null = null, planErrors: PlanIssue[] = []): EngineError {
  return {
    code,
    reason,
    planErrors,
    report: { code, reason, message: 'm', detail: '<path>: failed', exitCode: null, phase: null, app: { desktop: '0.1.0' } },
  } as EngineError;
}

const progress = (phase: string, overallProgress: number, mediaTime?: number) =>
  ({ phase, overallProgress, phaseProgress: 0, ...(mediaTime === undefined ? {} : { mediaTime }) }) as unknown as ProgressEvent;

function render(element: ReactElement, language: Language = 'en'): string {
  const value = { language, t: (key: MessageKey, params?: Record<string, string | number>) => translate(language, key, params) };
  return renderToStaticMarkup(<I18nContext.Provider value={value}>{element}</I18nContext.Provider>);
}

/** Visible text of rendered markup. */
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

describe('flow', () => {
  test('input: exactly one .mp4; several files, folders and other files are refused with a notice', () => {
    expect(pickInput([input])).toEqual({ input });
    expect(pickInput(['/a/MOVIE.MP4'])).toEqual({ input: '/a/MOVIE.MP4' });
    expect(pickInput([input, '/a/b.mp4'])).toEqual({ notice: 'multiple' });
    expect(pickInput([])).toEqual({ notice: 'multiple' });
    expect(pickInput(['/a/notes.txt'])).toEqual({ notice: 'notMp4' });
    expect(pickInput(['/a/Videos'])).toEqual({ notice: 'notMp4' });
    expect(pickInput(['/a/movie.mov'])).toEqual({ notice: 'notMp4' });
  });

  test('select or drop -> analyzing -> plan -> converting -> complete', () => {
    let s: State = reduce(initialState, { type: 'files', paths: [input] });
    expect(s).toEqual({ screen: 'analyzing', input });
    s = reduce(s, { type: 'analyzed', message: planMessage });
    expect(s.screen).toBe('plan');
    s = reduce(s, { type: 'convert' });
    expect(s).toMatchObject({ screen: 'converting', progress: null, cancelling: false });
    s = reduce(s, { type: 'engine', message: { type: 'progress', event: progress('ENCODING_PASS_1', 0.2, 12) } });
    expect(s).toMatchObject({ screen: 'converting', progress: { phase: 'ENCODING_PASS_1' } });
    s = reduce(s, { type: 'engine', message: { type: 'done', result: { outputDir: '/Users/me/Movies/standard-16x9', isoFileName: 'standard-16x9.iso', checks: 45, notMeasured: 1 } } });
    expect(s).toEqual({ screen: 'complete', input, outputDir: '/Users/me/Movies/standard-16x9', isoFileName: 'standard-16x9.iso', notMeasured: 1, openFailed: false });
    expect(reduce(s, { type: 'reset' })).toEqual(initialState);
  });

  test('rejected drops stay on the home screen with a notice', () => {
    expect(reduce(initialState, { type: 'files', paths: ['/a/b.mp4', '/a/c.mp4'] })).toEqual({ screen: 'home', notice: 'multiple' });
    expect(reduce(initialState, { type: 'files', paths: ['/a/Folder'] })).toEqual({ screen: 'home', notice: 'notMp4' });
  });

  test('warnings allow Convert; plan errors do not', () => {
    const planned = (data: PlanMessage): State => ({ screen: 'plan', input, data });
    expect(reduce(planned(withPlan({ warnings: [{ code: 'HDR_TONEMAP_EXPERIMENTAL' }] })), { type: 'convert' }).screen).toBe('converting');
    const blocked = planned(withPlan({ errors: [{ code: 'UNSUPPORTED_HDR' }] }));
    expect(reduce(blocked, { type: 'convert' })).toBe(blocked);
  });

  test('analysis errors (broken MP4, missing tool) go to the error screen', () => {
    const analyzing: State = { screen: 'analyzing', input };
    const broken = reduce(analyzing, { type: 'analyzed', message: { type: 'error', error: engineError('INPUT_ERROR', 'UNREADABLE_MEDIA') } });
    expect(broken).toMatchObject({ screen: 'failed', error: { reason: 'UNREADABLE_MEDIA' } });
  });

  test('cancel: cancelling state, then the engine reports CANCELLED', () => {
    let s: State = { screen: 'converting', input, data: planMessage, progress: null, cancelling: false };
    s = reduce(s, { type: 'cancelRequested' });
    expect(s).toMatchObject({ cancelling: true });
    s = reduce(s, { type: 'engine', message: { type: 'error', error: engineError('CANCELLED') } });
    expect(s).toMatchObject({ screen: 'failed', error: { code: 'CANCELLED' } });
  });

  test('the engine ending without a result is an error; stray events are ignored', () => {
    const converting: State = { screen: 'converting', input, data: planMessage, progress: null, cancelling: false };
    expect(reduce(converting, { type: 'engineExit', code: null })).toMatchObject({ screen: 'failed', error: { code: 'INTERNAL_ERROR' } });
    expect(reduce(converting, { type: 'files', paths: ['/a/other.mp4'] })).toBe(converting);
    expect(reduce(initialState, { type: 'engine', message: { type: 'done' } as EngineMessage })).toBe(initialState);
  });

  test('changing the output folder replans the same input', () => {
    const s: State = { screen: 'plan', input, data: planMessage };
    const next = { ...planMessage, outputFolder: '/Volumes/USB/standard-16x9' };
    expect(reduce(s, { type: 'replanned', message: next })).toEqual({ screen: 'plan', input, data: next });
  });
});

describe('screens', () => {
  test('home: title, subtitle, drop area, file picker and privacy note (EN and JA)', () => {
    const home = text(render(<Home notice={null} dragging={false} onSelect={noop} />));
    expect(home).toBe('MP4 to IFO Create DVD-Video files from an MP4. Drop an MP4 here or Select MP4 Your video never leaves your computer.');
    const ja = text(render(<Home notice={null} dragging={false} onSelect={noop} />, 'ja'));
    expect(ja).toContain('動画がこのMacから外部へ送信されることはありません。');
    expect(text(render(<Home notice="multiple" dragging={false} onSelect={noop} />))).toContain('Drop one MP4 at a time.');
    expect(text(render(<Home notice="notMp4" dragging={false} onSelect={noop} />))).toContain('Only .mp4 files can be converted.');
  });

  test('analyzing', () => {
    expect(text(render(<Analyzing />))).toBe('Analyzing video…');
    expect(render(<Analyzing />)).toContain('role="status"');
  });

  test('plan: input facts, DVD output, size and output folder', () => {
    const t = text(render(<Plan data={planMessage} onConvert={noop} onChangeOutput={noop} onAnother={noop} />));
    for (const part of ['standard-16x9.mp4', '1920 × 1080', '1:00', '29.97 fps', 'Stereo', 'NTSC · 16:9', '720 × 480', 'AC-3 Stereo', 'Estimated size', '/Users/me/Movies/standard-16x9', 'Convert']) {
      expect(t).toContain(part);
    }
  });

  test('plan: warnings are labelled "Warning" and allow Convert; errors are "Cannot convert" and disable it', () => {
    const warned = render(<Plan data={withPlan({ warnings: [{ code: 'DOWNMIX_TO_STEREO' }] })} onConvert={noop} onChangeOutput={noop} onAnother={noop} />);
    expect(warned).toContain('class="issues warnings"');
    expect(text(warned)).toContain('Warning 5.1 audio will be mixed down to stereo.');
    expect(warned).not.toMatch(/<button[^>]*disabled[^>]*>Convert/);

    const blocked = render(<Plan data={withPlan({ errors: [{ code: 'UNSUPPORTED_AUDIO_LAYOUT', data: { detail: '4 channels' } }] })} onConvert={noop} onChangeOutput={noop} onAnother={noop} />);
    expect(blocked).toContain('class="issues errors"');
    expect(text(blocked)).toContain('Cannot convert This audio layout is not supported.');
    expect(blocked).toMatch(/<button[^>]*disabled[^>]*>Convert/);
  });

  test('converting: phase, bar, percent and processed time as text; no time estimate', () => {
    const html = render(<Converting progress={progress('ENCODING_PASS_2', 0.614, 83.4)} cancelling={false} onCancel={noop} />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="61"');
    expect(text(html)).toBe('Creating DVD-Video 61% Encoding · Pass 2 of 2 1:23 processed Cancel');
    expect(text(html)).not.toMatch(/remaining|left|ETA/i);
    const cancelling = render(<Converting progress={progress('ENCODING_PASS_2', 0.614, 83.4)} cancelling onCancel={noop} />);
    expect(text(cancelling)).toContain('Cancelling…');
    expect(cancelling).toMatch(/<button[^>]*disabled[^>]*>Cancel/);
  });

  test('every phase has a label in both languages', () => {
    for (const phase of ['ANALYZING', 'PREFLIGHT', 'ENCODING_PASS_1', 'ENCODING_PASS_2', 'AUTHORING', 'CREATING_ZIP', 'CREATING_ISO', 'VERIFYING', 'FINALIZING', 'COMPLETED']) {
      expect(en).toHaveProperty(`phase.${phase}`);
      expect(ja).toHaveProperty(`phase.${phase}`);
    }
  });

  test('complete: software verification, the files, Open Output Folder; no burn guide without a URL', () => {
    const t = text(render(<Complete outputDir="/Users/me/Movies/standard-16x9" isoFileName="standard-16x9.iso" notMeasured={0} openFailed={false} onOpen={noop} onGuide={noop} onAnother={noop} />));
    expect(t).toContain('Software verification passed.');
    expect(t).toContain('VIDEO_TS/ VIDEO_TS.zip standard-16x9.iso');
    expect(t).toContain('Open Output Folder');
    expect(t).toContain('Convert Another');
    expect(t).not.toContain('How to Burn a DVD');
    expect(t).not.toContain('Could not open');
  });

  test('complete: a failed Open Output Folder is shown, in both languages', () => {
    const props = { outputDir: '/o/m', isoFileName: 'm.iso', notMeasured: 0, openFailed: true, onOpen: noop, onGuide: noop, onAnother: noop };
    const en = render(<Complete {...props} />);
    expect(en).toContain('<p class="error-text" role="alert">Could not open the output folder.</p>');
    expect(render(<Complete {...props} />, 'ja')).toContain('出力フォルダを開けませんでした。');
  });

  test('failed: plain message, Copy Error Details, no report details on screen, no Report Issue without a URL', () => {
    const html = render(<Failed error={engineError('INPUT_ERROR', 'UNREADABLE_MEDIA')} onCopy={() => Promise.resolve()} onAnother={noop} onReport={noop} />);
    expect(text(html)).toBe('Conversion Failed The file could not be read as an MP4 video. It may be damaged. Copy Error Details Choose Another MP4');
    expect(html).not.toContain('&lt;path&gt;');
    const cancelled = text(render(<Failed error={engineError('CANCELLED')} onCopy={() => Promise.resolve()} onAnother={noop} onReport={noop} />));
    expect(cancelled).toBe('Conversion Cancelled The conversion was cancelled. No output was kept. Choose Another MP4');
  });

  test('settings: language, version, updates and licenses', () => {
    const html = render(<Settings language="ja" version="0.1.0" onLanguage={noop} onLicenses={() => Promise.resolve([])} onClose={noop} />, 'ja');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('<option value="en">English</option><option value="ja" selected="">日本語</option>');
    for (const part of ['言語', 'バージョン', '0.1.0', 'アップデートを確認', 'オープンソースライセンス', '閉じる']) expect(text(html)).toContain(part);
  });

  test('updates: not available in this build (a release build is not a development build)', () => {
    expect(config.updatesEnabled).toBe(false);
    expect(en['settings.updatesUnavailable']).toBe('Update checking is not available in this build.');
    expect(ja['settings.updatesUnavailable']).toBe('このビルドでは、アップデートの確認は利用できません。');
  });

  test('app: starts on the home screen in the macOS language', () => {
    const bridge = new Proxy({}, { get: () => () => new Promise(() => {}) }) as Bridge;
    expect(text(renderToStaticMarkup(<App bridge={bridge} languages={['ja-JP', 'en-US']} />))).toContain('MP4 から DVD-Video のファイルを作成します。');
    expect(text(renderToStaticMarkup(<App bridge={bridge} languages={['fr-FR']} />))).toContain('Create DVD-Video files from an MP4.');
  });
});

describe('open output folder', () => {
  const complete: State = { screen: 'complete', input, outputDir: '/o/m', isoFileName: 'm.iso', notMeasured: 0, openFailed: false };

  test('the web view passes no path: the backend opens the verified output folder', async () => {
    expectTypeOf<Bridge['openOutputFolder']>().parameters.toEqualTypeOf<[]>();
    const bridge = await tauriBridge();
    await bridge.openOutputFolder();
    expect(invoke.mock.calls).toEqual([['open_output_folder']]);
  });

  test('a failure is kept on the complete screen until it works', () => {
    const failed = reduce(complete, { type: 'opened', ok: false });
    expect(failed).toEqual({ ...complete, openFailed: true });
    expect(reduce(failed, { type: 'opened', ok: true })).toEqual(complete);
    expect(reduce(initialState, { type: 'opened', ok: false })).toBe(initialState);
  });

  test('capabilities: the web view cannot open paths, and only the configured URLs', () => {
    const capabilities = JSON.parse(fs.readFileSync(new URL('../../src-tauri/capabilities/default.json', import.meta.url), 'utf8')) as {
      permissions: (string | { identifier: string; allow?: { url?: string }[] })[];
    };
    const opener = capabilities.permissions.filter((p) => (typeof p === 'string' ? p : p.identifier).startsWith('opener:'));
    const urls = [config.burnGuideUrl, config.reportIssueUrl].filter((u): u is string => u !== null);
    for (const p of opener) {
      // Only URL permissions, each scoped to exact https URLs from config (no wildcards, no paths).
      expect(typeof p === 'string' ? p : p.identifier).toBe('opener:allow-open-url');
      expect(typeof p).toBe('object');
      for (const entry of (p as { allow?: { url?: string }[] }).allow ?? []) {
        expect(urls).toContain(entry.url);
        expect(entry.url).toMatch(/^https:\/\/[^*]+$/);
      }
    }
    if (urls.length === 0) expect(opener).toEqual([]);
  });
});

describe('languages', () => {
  test('Japanese has every English key, none empty', () => {
    expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());
    for (const [key, value] of Object.entries(ja)) expect(value, key).not.toBe('');
  });

  test('placeholders are the same in both languages', () => {
    const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en) as MessageKey[]) expect(names(ja[key]), key).toEqual(names(en[key]));
  });

  test('default follows macOS: Japanese first -> ja, anything else -> en', () => {
    expect(systemLanguage(['ja-JP', 'en-US'])).toBe('ja');
    expect(systemLanguage(['ja'])).toBe('ja');
    expect(systemLanguage(['en-US', 'ja-JP'])).toBe('en');
    expect(systemLanguage(['de-DE'])).toBe('en');
    expect(systemLanguage([])).toBe('en');
  });

  test('a chosen language is stored and wins over the macOS language', () => {
    const map = new Map<string, string>();
    const store = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
    expect(loadLanguage(store, ['ja-JP'])).toBe('ja');
    saveLanguage(store, 'en');
    expect(loadLanguage(store, ['ja-JP'])).toBe('en');
    map.set('mp4-to-ifo.language', 'fr');
    expect(loadLanguage(store, ['ja-JP'])).toBe('ja');
  });

  test('placeholders are filled', () => {
    expect(translate('en', 'converting.processed', { time: '1:23' })).toBe('1:23 processed');
    expect(translate('ja', 'notify.done.body', { name: 'a.mp4' })).toBe('a.mp4 の変換が完了しました。');
  });
});

describe('messages', () => {
  test('errors map to plain messages', () => {
    expect(errorMessage(engineError('INPUT_ERROR', 'UNREADABLE_MEDIA')).key).toBe('error.UNREADABLE_MEDIA');
    expect(errorMessage(engineError('PREFLIGHT_ERROR', 'TOOL_MISSING')).key).toBe('error.TOOL_MISSING');
    expect(errorMessage(engineError('VERIFY_ERROR', 'SOMETHING_NEW')).key).toBe('error.VERIFY_ERROR');
    expect(errorMessage(engineError('INPUT_ERROR', 'UNSUPPORTED_AUDIO_LAYOUT', [{ code: 'UNSUPPORTED_AUDIO_LAYOUT' }])).key).toBe('planError.UNSUPPORTED_AUDIO_LAYOUT');
    expect(errorMessage(engineError('WHATEVER')).key).toBe('error.WHATEVER');
  });

  test('every error code and known reason has text', () => {
    for (const code of ['INPUT_ERROR', 'PREFLIGHT_ERROR', 'ENCODE_ERROR', 'AUTHOR_ERROR', 'ZIP_ERROR', 'ISO_ERROR', 'OUTPUT_ERROR', 'VERIFY_ERROR', 'CANCELLED', 'INTERNAL_ERROR']) {
      expect(en).toHaveProperty(`error.${code}`);
    }
  });

  test('formatting', () => {
    expect(formatDuration(59.9)).toBe('0:59');
    expect(formatDuration(3725)).toBe('1:02:05');
    expect(formatFps(30000 / 1001)).toBe('29.97');
    expect(formatFps(24000 / 1001)).toBe('23.976');
    expect(formatFps(25)).toBe('25');
    expect(formatSize(62_500_000)).toBe('63 MB');
    expect(formatSize(4_300_000_000)).toBe('4.30 GB');
  });
});

describe('appearance', () => {
  const css = fs.readFileSync(new URL('../../src/styles.css', import.meta.url), 'utf8');

  test('light background #f4f1ea; dark mode follows macOS', () => {
    expect(css).toMatch(/--bg:\s*#f4f1ea/);
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\)\s*{\s*:root\s*{[^}]*--bg:/);
  });

  test('SENA style: no shadows, gradients or large radii; visible focus', () => {
    expect(css).not.toMatch(/box-shadow|gradient/);
    for (const [, px] of css.matchAll(/border-radius:\s*(\d+)px/g)) expect(Number(px)).toBeLessThanOrEqual(4);
    expect(css).toMatch(/:focus-visible/);
  });
});
