import { useCallback, useEffect, useState } from 'react';
import { Announce } from '../components/Announce';
import { CELL_IDS, SCOPE_LABEL_KEY, SOURCE_LABEL_KEY, parseCellId, totalCount } from '../core/cells';
import { startExternalSync } from '../core/persist';
import { checklistStore } from '../core/store';
import type { CellId, Scope, Source } from '../core/types';
import { useLocale } from '../i18n/react';
import { EXT_NAME, openChecklistPage } from '../shared/extension';
import { useChecklist, useHydrated } from '../shared/useChecklist';

/**
 * Popup (CODING_PLAN §6) -- M4: real counts for the four cells + the total + opening the Checklist page.
 *
 * The layout is "General/Individual as rows × Internal/External as columns", matching the wireframe
 * in §1.1, and the order is just `CELL_IDS` (general-internal → general-external → individual-…).
 *
 * The table stores scope/source rather than ready-made labels: a module-level constant is evaluated
 * only once when the script loads, so it won't follow a language change (same as TABS in App.tsx).
 * The separator between them is a catalog key too.
 */
const CELL_LAYOUT: ReadonlyArray<{ cell: CellId; scope: Scope; source: Source }> = CELL_IDS.map(
  (cell) => ({ cell, ...parseCellId(cell) }),
);

/** Popup body: the four cell counts, the total, error hints, and the button that opens the full-page app. */
export function PopupApp() {
  const [busy, setBusy] = useState(false);
  const [openError, setOpenError] = useState<string>();
  const { t } = useLocale();

  // chrome only exists in an extension context (this also lets the component be rendered/tested on its own)
  const canOpen = typeof chrome !== 'undefined' && !!chrome.runtime?.id;

  // One subscription gets the whole cells object and derives the total from it: with separate
  // subscriptions the four cells and the total could land on different frames in edge cases, and
  // you'd see a flicker where "the four cells don't add up to the total".
  const cells = useChecklist((s) => s.doc.cells);
  const hydrated = useHydrated();
  const lastError = useChecklist((s) => s.lastError);
  const total = totalCount(cells);

  // The visible line and the announced sentence have to be the same text, so build it once here and share it between both.
  const readError = lastError ? t('popup.readError', { detail: lastError }) : undefined;
  const pageError = openError ? t('popup.pageError', { detail: openError }) : undefined;

  useEffect(() => {
    // The popup is its own realm, the store has no data hydrated elsewhere, so it has to read once on every open.
    const stopSync = startExternalSync();
    void checklistStore.getState().hydrate();
    return stopSync;
  }, []);

  const handleOpen = useCallback(() => {
    if (!canOpen || busy) return;
    setBusy(true);
    setOpenError(undefined);
    // Opening the page is the popup's only way out, so a failure can't just leave the button
    // springing back into place: to the user that looks exactly like "clicking does nothing", and
    // they'll keep clicking.
    void openChecklistPage()
      .catch((e: unknown) => setOpenError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [canOpen, busy]);

  return (
    <div className="pu" data-hydrated={hydrated ? 'true' : 'false'}>
      <header className="pu__header">
        <span className="pu__dot" aria-hidden="true" />
        <span className="pu__title">{EXT_NAME}</span>
        {hydrated ? <span className="pu__subtitle">{t('popup.total', { count: total })}</span> : null}
      </header>

      <div className="pu__grid" role="group" aria-label={t('popup.gridAria')}>
        {CELL_LAYOUT.map(({ cell, scope, source }) => (
          <div key={cell} className="pu__cell" data-cell={cell}>
            <div className="pu__cell-label">
              <span className="pu__cell-dot" aria-hidden="true" />
              {t('popup.cellLabel', {
                scope: t(SCOPE_LABEL_KEY[scope]),
                source: t(SOURCE_LABEL_KEY[source]),
              })}
            </div>
            {/* Don't show 0 before hydration: that would flash "there's nothing here" in front of a user who has data */}
            <div className="pu__cell-count">{hydrated ? cells[cell].length : '–'}</div>
          </div>
        ))}
      </div>

      {/* The popup is narrow and usually summoned from the keyboard, and screen-reader users are
          especially common here, so announce from here too. */}
      <Announce kind="assertive" text={readError ?? pageError ?? ''} />

      {readError ? (
        <p className="pu__hint pu__hint--error">{readError}</p>
      ) : pageError ? (
        <p className="pu__hint pu__hint--error">{pageError}</p>
      ) : hydrated && total === 0 ? (
        // No separate button for the empty state: right below is "打开 Checklist 页面", and
        // another button that looks the same would only make people think there are two different
        // paths. The copy explains both paths at once -- clicking the extension icon on a discussion
        // page grabs one directly, and the "+" on the page adds one by hand.
        <p className="pu__hint">{t('popup.empty')}</p>
      ) : null}

      <button type="button" className="pu__open" onClick={handleOpen} disabled={!canOpen || busy}>
        {t('popup.openPage')}
      </button>
    </div>
  );
}
