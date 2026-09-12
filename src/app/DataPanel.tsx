import { useRef, useState } from 'react';
import { Announce } from '../components/Announce';
import { totalCount } from '../core/cells';
import {
  downloadText,
  exportFileName,
  mergeDocs,
  parseDocJson,
  readFileAsText,
  serializeDoc,
  type ImportMode,
} from '../core/exchange';
import { flushPersist } from '../core/persist';
import { checklistStore } from '../core/store';
import { useLocale } from '../i18n/react';
import { useChecklist, useSaveState } from '../shared/useChecklist';

/** Data panel: export / import (merge or overwrite) / clear (double confirm). CODING_PLAN §9. */
export function DataPanel() {
  const total = useChecklist((s) => totalCount(s.doc.cells));
  const deviceId = useChecklist((s) => s.doc.deviceId);
  const docUpdatedAt = useChecklist((s) => s.doc.updatedAt);
  const { saving, lastSavedAt, lastError } = useSaveState();
  const { t, locale } = useLocale();

  const [mode, setMode] = useState<ImportMode>('merge');
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirmClear, setConfirmClear] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // The visible one and the announced one have to be exactly the same, so build it once and
  // use it twice (rather than writing it out twice and someday changing only half of it).
  // `lastError` comes from the persistence layer (`errorMessage(e)`) and is a technical
  // string, not a `Msg` -- there's nothing translatable in it, so just embed it as `{detail}`.
  const persistError = lastError ? t('data.persistError', { detail: lastError }) : '';

  /** Download the current document as a JSON file. */
  const onExport = () => {
    const doc = checklistStore.getState().doc;
    downloadText(exportFileName(), serializeDoc(doc));
    setError(undefined);
    setNotice(t('data.exported', { count: totalCount(doc.cells) }));
  };

  /**
   * Read the file the user picked and merge or overwrite the local document according to the
   * currently selected mode.
   *
   * @param file the file selected in the file picker
   */
  const onImportFile = async (file: File) => {
    try {
      const text = await readFileAsText(file);
      const { doc: incoming, dropped } = parseDocJson(text);

      if (mode === 'overwrite') {
        checklistStore.getState().replaceDoc(incoming);
        await flushPersist();
        setNotice(
          t(dropped > 0 ? 'data.importOverwriteDropped' : 'data.importOverwrite', {
            count: totalCount(incoming.cells),
            dropped,
          }),
        );
      } else {
        const { doc, added, skipped } = mergeDocs(checklistStore.getState().doc, incoming);
        checklistStore.getState().replaceDoc(doc);
        await flushPersist();
        setNotice(
          t(dropped > 0 ? 'data.importMergedDropped' : 'data.importMerged', {
            added,
            skipped,
            dropped,
          }),
        );
      }
      setError(undefined);
    } catch (e) {
      setNotice(undefined);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Clear all entries. The double confirm must have happened before this is called. */
  const onClear = async () => {
    checklistStore.getState().clearAll();
    await flushPersist();
    setConfirmClear(false);
    setError(undefined);
    setNotice(t('data.cleared'));
  };

  return (
    // data-panel: the smoke test needs to hit this block's `.ok-text` directly -- there are
    // two `.panel`s on the settings page, and the sync panel's card also renders an `.ok-text`
    // when connected (the badge).
    <section className="panel" data-panel="data">
      <h2 className="panel__title">{t('data.title')}</h2>

      <dl className="stats">
        <div className="stats__item">
          <dt>{t('data.totalEntries')}</dt>
          <dd>{total}</dd>
        </div>
        <div className="stats__item">
          <dt>{t('data.deviceId')}</dt>
          <dd className="mono">{deviceId}</dd>
        </div>
        <div className="stats__item">
          <dt>{t('data.docUpdated')}</dt>
          <dd>{formatTime(docUpdatedAt, locale)}</dd>
        </div>
        <div className="stats__item">
          <dt>{t('data.saveStatus')}</dt>
          <dd>
            {saving
              ? t('data.saving')
              : lastSavedAt
                ? t('data.savedAt', { time: formatTime(lastSavedAt, locale) })
                : '—'}
          </dd>
        </div>
      </dl>

      {/* These three are all persistent notices (no toast reuse): import/export results and
          persistence failures should stay on the page, since the user may not look back for a
          few seconds. Persistent means no toast "ding", so we announce them ourselves.
          (`Announce` only speaks; the lines below are the visible copy.) */}
      <Announce kind="polite" text={notice ?? ''} />
      <Announce kind="assertive" text={[persistError, error].filter(Boolean).join('；')} />

      {persistError && <p className="error-text">{persistError}</p>}
      {error && <p className="error-text">{error}</p>}
      {notice && <p className="ok-text">{notice}</p>}

      <div className="row">
        <button type="button" className="btn btn--accent" data-action="export-json" onClick={onExport}>
          {t('data.exportJson')}
        </button>

        <div className="seg" role="radiogroup" aria-label={t('data.importModeAria')}>
          <label className={`seg__opt${mode === 'merge' ? ' seg__opt--on' : ''}`}>
            <input
              type="radio"
              name="import-mode"
              value="merge"
              checked={mode === 'merge'}
              onChange={() => setMode('merge')}
            />
            {t('data.modeMerge')}
          </label>
          <label className={`seg__opt${mode === 'overwrite' ? ' seg__opt--on' : ''}`}>
            <input
              type="radio"
              name="import-mode"
              value="overwrite"
              checked={mode === 'overwrite'}
              onChange={() => setMode('overwrite')}
            />
            {t('data.modeOverwrite')}
          </label>
        </div>

        <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
          {t('data.importJson')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="visually-hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void onImportFile(file);
          }}
        />
      </div>

      <div className="row row--danger">
        {confirmClear ? (
          <>
            <span className="muted">{t('data.clearConfirm')}</span>
            <button type="button" className="btn btn--danger" onClick={() => void onClear()}>
              {t('data.clearYes')}
            </button>
            <button type="button" className="btn" onClick={() => setConfirmClear(false)}>
              {t('common.cancel')}
            </button>
          </>
        ) : (
          <button type="button" className="btn" onClick={() => setConfirmClear(true)}>
            {t('data.clearData')}
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * Format a time according to the UI language (same as SyncPanel): this is where `2026/9/11`
 * and `9/11/2026` diverge.
 *
 * @param ts the timestamp to format
 * @param locale the UI language
 * @returns the time shown to the user; `—` when there's no timestamp
 */
function formatTime(ts: number | undefined, locale: string): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(locale);
}
