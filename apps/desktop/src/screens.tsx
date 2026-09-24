// Screens of the single flow. They render state and call back; no conversion logic here.

import { useEffect, useRef, useState } from 'react';
import { config } from './config.ts';
import type { PlanMessage } from './flow.ts';
import { useI18n, type Language, type MessageKey } from './i18n/index.ts';
import { errorMessage, formatDuration, formatFps, formatSize, planIssueMessage } from './messages.ts';
import type { EngineError, ProgressEvent } from './engine-types.ts';

export function Home(props: { notice: 'notMp4' | 'multiple' | null; dragging: boolean; onSelect: () => void }) {
  const { t } = useI18n();
  return (
    <section className="home">
      <h1>{t('appName')}</h1>
      <p className="muted">{t('home.subtitle')}</p>
      <div className={`drop${props.dragging ? ' active' : ''}`} aria-hidden="true">
        {t('home.drop')}
      </div>
      <p className="muted or">{t('home.or')}</p>
      <button type="button" className="primary" onClick={props.onSelect} autoFocus>
        {t('home.select')}
      </button>
      <p className="notice" role="status" aria-live="polite">
        {props.notice ? t(props.notice === 'notMp4' ? 'home.notice.notMp4' : 'home.notice.multiple') : ''}
      </p>
      <p className="muted privacy">{t('privacy')}</p>
    </section>
  );
}

export function Analyzing() {
  const { t } = useI18n();
  return (
    <section className="center" role="status" aria-live="polite">
      <p>{t('analyzing.title')}</p>
    </section>
  );
}

function audioText(t: ReturnType<typeof useI18n>['t'], audio: PlanMessage['analysis']['audio']): string {
  if (!audio) return t('plan.noAudio');
  const key = ({ 1: 'plan.channels.1', 2: 'plan.channels.2', 6: 'plan.channels.6' } as Record<number, MessageKey>)[audio.channels];
  return key && (audio.channels !== 6 || audio.layout?.startsWith('5.1')) ? t(key) : t('plan.channels.n', { n: audio.channels });
}

export function Plan(props: { data: PlanMessage; onConvert: () => void; onChangeOutput: () => void; onAnother: () => void }) {
  const { t } = useI18n();
  const { analysis: a, plan, outputFolder } = props.data;
  const blocked = plan.errors.length > 0;
  return (
    <section className="plan">
      <h1 className="file">{a.fileName}</h1>
      <dl className="facts">
        <div>
          <dt>{t('plan.input')}</dt>
          <dd>
            <span>{a.width} × {a.height}</span>
            <span>{formatDuration(a.duration)}</span>
            <span>{a.variableFrameRate ? t('plan.vfr') : `${formatFps(a.frameRate)} fps`}</span>
            <span>{audioText(t, a.audio)}</span>
          </dd>
        </div>
        <div>
          <dt>{t('plan.dvd')}</dt>
          <dd>
            <span>NTSC · 16:9</span>
            <span>720 × 480</span>
            <span>{t(`strategy.${plan.video.frameRate.strategy}` as MessageKey)}</span>
            <span>{plan.audio ? t(`audio.${plan.audio.strategy}` as MessageKey) : '—'}</span>
          </dd>
        </div>
        <div>
          <dt>{t('plan.size')}</dt>
          <dd>{t('plan.sizeValue', { size: formatSize(plan.expected.streamBytes) })}</dd>
        </div>
        <div>
          <dt>{t('plan.output')}</dt>
          <dd className="output">
            <span className="path">{outputFolder}</span>
            <button type="button" className="link" onClick={props.onChangeOutput}>
              {t('plan.change')}
            </button>
          </dd>
        </div>
      </dl>
      {plan.errors.length > 0 && (
        <ul className="issues errors">
          {plan.errors.map((issue) => {
            const m = planIssueMessage(issue, 'planError');
            return (
              <li key={issue.code}>
                <strong>{t('plan.error')}</strong> {t(m.key, m.params)}
              </li>
            );
          })}
        </ul>
      )}
      {plan.warnings.length > 0 && (
        <ul className="issues warnings">
          {plan.warnings.map((issue) => {
            const m = planIssueMessage(issue, 'warning');
            return (
              <li key={issue.code}>
                <strong>{t('plan.warning')}</strong> {t(m.key, m.params)}
              </li>
            );
          })}
        </ul>
      )}
      <div className="actions">
        <button type="button" onClick={props.onAnother}>
          {t('plan.another')}
        </button>
        <button type="button" className="primary" onClick={props.onConvert} disabled={blocked} autoFocus={!blocked}>
          {t('plan.convert')}
        </button>
      </div>
    </section>
  );
}

export function Converting(props: { progress: ProgressEvent | null; cancelling: boolean; onCancel: () => void }) {
  const { t } = useI18n();
  const p = props.progress;
  const percent = Math.round((p?.overallProgress ?? 0) * 100);
  return (
    <section className="center converting">
      <h1>{t('converting.title')}</h1>
      <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={t('converting.title')}>
        <div style={{ width: `${percent}%` }} />
      </div>
      <p className="percent">{percent}%</p>
      <p className="muted" aria-live="polite">
        {props.cancelling ? t('converting.cancelling') : p ? t(`phase.${p.phase}` as MessageKey) : t('phase.ANALYZING')}
      </p>
      <p className="muted time">{p?.mediaTime !== undefined && !props.cancelling ? t('converting.processed', { time: formatDuration(p.mediaTime) }) : ' '}</p>
      <button type="button" onClick={props.onCancel} disabled={props.cancelling}>
        {t('converting.cancel')}
      </button>
    </section>
  );
}

export function Complete(props: { outputDir: string; isoFileName: string; notMeasured: number; onOpen: () => void; onGuide: () => void; onAnother: () => void }) {
  const { t } = useI18n();
  return (
    <section className="complete">
      <h1>{t('complete.title')}</h1>
      <p>{t('complete.verified')}{props.notMeasured ? ` ${t('complete.notMeasured', { n: props.notMeasured })}` : ''}</p>
      <ul className="files">
        <li>VIDEO_TS/</li>
        <li>VIDEO_TS.zip</li>
        <li>{props.isoFileName}</li>
      </ul>
      <p className="muted path">{props.outputDir}</p>
      <button type="button" className="primary" onClick={props.onOpen} autoFocus>
        {t('complete.open')}
      </button>
      <p className="advice">{t('complete.test')}</p>
      <div className="actions">
        {config.burnGuideUrl && (
          <button type="button" onClick={props.onGuide}>
            {t('complete.burnGuide')}
          </button>
        )}
        <button type="button" onClick={props.onAnother}>
          {t('complete.another')}
        </button>
      </div>
    </section>
  );
}

export function Failed(props: { error: EngineError; onCopy: () => Promise<void>; onAnother: () => void; onReport: () => void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const m = errorMessage(props.error);
  const cancelled = props.error.code === 'CANCELLED';
  return (
    <section className="failed">
      <h1>{t(cancelled ? 'failed.cancelled' : 'failed.title')}</h1>
      <p className={cancelled ? '' : 'error-text'} role="alert">
        {t(m.key, m.params)}
      </p>
      <div className="actions">
        {!cancelled && (
          <button type="button" onClick={() => void props.onCopy().then(() => setCopied(true))}>
            {copied ? t('failed.copied') : t('failed.copy')}
          </button>
        )}
        {!cancelled && config.reportIssueUrl && (
          <button type="button" onClick={props.onReport}>
            {t('failed.report')}
          </button>
        )}
        <button type="button" className="primary" onClick={props.onAnother} autoFocus>
          {t('failed.another')}
        </button>
      </div>
    </section>
  );
}

export function Settings(props: {
  language: Language;
  version: string;
  onLanguage: (language: Language) => void;
  onLicenses: () => Promise<{ name: string; text: string }[]>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [updateNote, setUpdateNote] = useState(false);
  const [licenses, setLicenses] = useState<{ name: string; text: string }[] | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>('select, button')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props]);
  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label={t('settings')} ref={dialog}>
      {licenses ? (
        <div className="licenses">
          <h2>{t('settings.licenses')}</h2>
          {licenses.map((l) => (
            <details key={l.name}>
              <summary>{l.name}</summary>
              <pre>{l.text}</pre>
            </details>
          ))}
          <button type="button" onClick={() => setLicenses(null)}>
            {t('settings.back')}
          </button>
        </div>
      ) : (
        <>
          <h2>{t('settings')}</h2>
          <dl className="facts">
            <div>
              <dt>
                <label htmlFor="language">{t('settings.language')}</label>
              </dt>
              <dd>
                <select id="language" value={props.language} onChange={(e) => props.onLanguage(e.target.value as Language)}>
                  <option value="en">English</option>
                  <option value="ja">日本語</option>
                </select>
              </dd>
            </div>
            <div>
              <dt>{t('settings.version')}</dt>
              <dd>{props.version}</dd>
            </div>
          </dl>
          <div className="actions stacked">
            <button type="button" onClick={() => setUpdateNote(true)}>
              {t('settings.updates')}
            </button>
            {updateNote && !config.updatesEnabled && <p className="muted" role="status">{t('settings.updatesUnavailable')}</p>}
            <button type="button" onClick={() => void props.onLicenses().then(setLicenses)}>
              {t('settings.licenses')}
            </button>
          </div>
          <p className="muted privacy">{t('privacy')}</p>
          <button type="button" className="primary" onClick={props.onClose}>
            {t('close')}
          </button>
        </>
      )}
    </div>
  );
}
