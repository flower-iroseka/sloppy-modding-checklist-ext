import { useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import { EntryDialog } from '../components/EntryDialog';
import { ToastHost, showToast } from '../components/toast';
import { flushPersist, startAutoPersist, startExternalSync } from '../core/persist';
import { checklistStore } from '../core/store';
import { initLocale, subscribeLocale, t } from '../i18n';
import { MSG_OPEN_APP } from '../shared/messages';
import themeCss from '../styles/theme.css?inline';
import uiCss from '../styles/ui.css?inline';
import './content.css';
import { getCurrentUserId } from './currentUser';
import { SELECTORS, safeQuery, safeQueryAll } from './locators';
import { readPostTarget, type PostTarget } from './osuUser';

/**
 * Content script (CODING_PLAN §8): on the osu! beatmap discussion page, inject a
 * "+ Add to Checklist" button into every post, plus a floating button that opens the full-page app.
 *
 * Two layers: the page DOM part uses plain DOM (lightweight, doesn't mind osu re-rendering), and
 * the overlay is a small React root mounted in a shadow DOM (fully isolated from the site's styles).
 */

// ---------------------------------------------------------------- Overlay state

/** The post the dialog is currently for; null means the dialog is closed. */
let pending: PostTarget | null = null;
/** React-side subscribers (`useSyncExternalStore`). */
const pendingListeners = new Set<() => void>();

function emitPending(): void {
  for (const l of pendingListeners) l();
}

/**
 * Record the post the dialog is for and notify the subscribers.
 *
 * @param next the target post; null means close the dialog
 */
function setPending(next: PostTarget | null): void {
  pending = next;
  emitPending();
}

/**
 * Subscribe to changes of the dialog target.
 *
 * @param l callback invoked on change
 * @returns unsubscribe function
 */
function subscribePending(l: () => void): () => void {
  pendingListeners.add(l);
  return () => {
    pendingListeners.delete(l);
  };
}

/**
 * The current dialog target, read as a snapshot by `useSyncExternalStore`.
 *
 * @returns the target post; null when there isn't one
 */
function getPending(): PostTarget | null {
  return pending;
}

// ---------------------------------------------------------------- shadow mount

/** Defaults used when there's no post context; the normal flow never hits them, since a null target keeps the dialog closed. */
const DEFAULTS = { scope: 'general', source: 'external' } as const;

/** The small React app inside the shadow DOM: the add-entry dialog + toasts. */
function ContentApp() {
  const target = useSyncExternalStore(subscribePending, getPending, getPending);

  return (
    <>
      <EntryDialog
        open={target !== null}
        mode="create"
        defaults={
          target
            ? {
                // Scope/source are both decided automatically from the collected context (CODING_PLAN §8.3):
                // position -> general(All difficulties / current difficulty) / individual(timeline),
                // author -> internal(self) / external(someone else)
                scope: target.recommendedScope,
                source: target.recommendedSource,
                // Prefill the whole post body and the permalink (CODING_PLAN §1.2)
                summary: target.text,
                links: [target.permalink],
                ...(target.author ? { sourceAuthor: target.author } : {}),
                meta: target.meta,
              }
            : { scope: DEFAULTS.scope, source: DEFAULTS.source }
        }
        recommendedSource={target?.recommendedSource}
        recommendedScope={target?.recommendedScope}
        detectedDifficulty={target?.difficulty}
        onSubmit={(input) => {
          checklistStore.getState().addEntry(input);
          setPending(null);
          // Persist right away so it isn't lost if the user closes the tab immediately
          void flushPersist().then(
            () => showToast(t('content.added')),
            () => showToast(t('content.addedLocalSaveFailed'), 'error'),
          );
        }}
        onCancel={() => setPending(null)}
      />
      <ToastHost />
    </>
  );
}

/** Whether the overlay has already been mounted (osu is an SPA, this code may run several times). */
let mounted = false;

/**
 * Move theme.css into the shadow root: the `:root` selector matches nothing here, it has to become `:host`.
 *
 * Only replace a `:root` that's immediately followed by `{`. Don't take the shortcut of writing
 * `replace(':root', ':host')` -- that hits the `:root` text in the file comments first, so the
 * comment gets rewritten while the real selector stays untouched. The symptom is all theme
 * variables coming out empty (translucent panel background, black text), and no error at all.
 * Been there once.
 *
 * @returns theme.css with the selector swapped
 */
function themeForShadowRoot(): string {
  return themeCss.replace(/:root(?=\s*\{)/g, ':host');
}

/** Create the shadow DOM host and mount theme.css + ui.css + the React overlay into it. Only mounts once. */
function mountOverlay(): void {
  if (mounted || document.getElementById('mc-overlay-host')) return;
  mounted = true;

  const host = document.createElement('div');
  host.id = 'mc-overlay-host';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  // 1) `all: initial` cuts off the font/color/line-height inherited from the osu page (the page is
  //    html{font-size:10px}, and without cutting it off the sizes here would follow the site);
  // 2) there's no body in a shadow root, so theme.css's body rules don't apply -- the base font
  //    size/family get filled in here.
  style.textContent = [
    ':host{all:initial;font-family:var(--font);font-size:var(--font-size-base);line-height:1.5;color:var(--text)}',
    themeForShadowRoot(),
    uiCss,
  ].join('\n');
  shadow.appendChild(style);

  const mount = document.createElement('div');
  shadow.appendChild(mount);

  // Attach to documentElement instead of body, so layout/overflow on the site's body can't affect it
  document.documentElement.appendChild(host);
  createRoot(mount).render(<ContentApp />);

  // Regression guard: if the theme variables didn't make it in, it fails silently (just wrong
  // colors), so log it here on purpose.
  const bg = getComputedStyle(host).getPropertyValue('--bg-surface').trim();
  if (!bg) {
    console.warn(
      '[sloppy-mod-checklist] the theme variables were not injected into the shadow root (the theme.css selector rewrite may have failed), the overlay colours will fall back to the defaults',
    );
  }
}

// ---------------------------------------------------------------- Injection: per post

/**
 * Click handler for the "＋" button: collect this post, then open the dialog.
 *
 * @param discussion the discussion this post belongs to
 * @param post the body block
 * @param button the button that was clicked, used on the error path
 */
async function onAddClicked(
  discussion: Element,
  post: Element,
  button: HTMLButtonElement,
): Promise<void> {
  try {
    // The current user is only readable in the main world, so it goes through the SW; the result is cached, so a second click doesn't round-trip again
    const currentUserId = await getCurrentUserId();
    const target = readPostTarget(discussion, post, currentUserId);
    if (!target) {
      showToast(t('content.readFailed'), 'error');
      return;
    }
    setPending(target);
  } catch (e) {
    // Site-redesign protection: don't throw beyond the page console, just show a toast
    console.warn('[sloppy-mod-checklist] could not read the post, the site layout may have changed', e);
    showToast(t('content.siteChanged'), 'error');
    button.removeAttribute('data-mc-ready');
  }
}

/**
 * All the "＋" buttons injected into the page.
 *
 * @returns the button list, used to refresh the text after a language change
 */
function injectedAddButtons(): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>('button.mc-add-btn'),
  );
}

/**
 * Sweep the page and add a "＋" to every post that doesn't have a button yet.
 *
 * @returns how many buttons were newly injected this time
 */
function injectPostButtons(): number {
  const discussions = safeQueryAll(document, SELECTORS.discussion);
  let injected = 0;

  for (const discussion of discussions) {
    // One discussion is a whole thread and may hold several posts (the OP + replies),
    // and each one has to be addable to the checklist on its own
    for (const post of safeQueryAll(discussion, SELECTORS.post)) {
      // Idempotent: skip if a button is already there (osu is an SPA, the same DOM gets swept repeatedly)
      if (safeQuery(post, '.mc-add-btn')) continue;

      const actions =
        safeQuery(post, SELECTORS.postActionsGroup) ?? safeQuery(post, SELECTORS.postActions);
      if (!actions) continue;

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'mc-add-btn';
      button.textContent = t('content.addEntry');
      button.title = t('content.addEntryTitle');
      button.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void onAddClicked(discussion, post, button);
      });

      actions.appendChild(button);
      injected += 1;
    }
  }

  return injected;
}

// ---------------------------------------------------------------- Injection: floating button

/**
 * The floating button's icon: lucide's `list-checks`, with the params copied from lucide's original
 * path data (24×24 viewBox, `stroke-width: 2`), the same drawing style as the icons in the app.
 *
 * Inlined as a string instead of importing a component because this button isn't in React -- it's
 * built with `document.createElement` and put into the osu main document (see `ensureFab`), so that
 * the page-level styles in content.css can reach it.
 */
const FAB_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true" focusable="false">
  <path d="M13 5h8"/><path d="M13 12h8"/><path d="M13 19h8"/>
  <path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/>
</svg>`;

/** Mount the floating button in the bottom left. Does nothing if it's already mounted. */
function ensureFab(): void {
  if (document.getElementById('mc-fab')) return;

  const fab = document.createElement('button');
  fab.id = 'mc-fab';
  fab.type = 'button';
  // A round button has no room for text, so "what is this" is carried entirely by these two
  // attributes: `title` gives mouse users a tooltip, `aria-label` gives screen readers something to
  // say (title alone isn't reliable).
  const label = t('content.openApp');
  fab.title = label;
  fab.setAttribute('aria-label', label);
  fab.innerHTML = FAB_ICON;
  fab.addEventListener('click', () => {
    try {
      // Content scripts don't have the chrome.tabs permission, so let the SW open the tab
      void chrome.runtime.sendMessage({ type: MSG_OPEN_APP }).catch(() => {
        showToast(t('content.openFailed'), 'error');
      });
    } catch (e) {
      console.warn('[sloppy-mod-checklist] sendMessage failed', e);
    }
  });

  document.documentElement.appendChild(fab);
}

// ---------------------------------------------------------------- Language switch

/**
 * Rewrite the injected text (the FAB's `title` / `aria-label`, each "＋"'s textContent / title).
 *
 * These aren't in the React tree (see `ensureFab`), so there's no `useLocale()` to use; and the
 * sweep skips buttons that already exist, so they don't update themselves when the language
 * changes -- this is the one place that refreshes them on purpose. Calling it while the elements
 * don't exist yet is safe, so it can be called right after the subscription is set up.
 */
function relabelInjected(): void {
  const fab = document.getElementById('mc-fab');
  if (fab) {
    const label = t('content.openApp');
    fab.title = label;
    fab.setAttribute('aria-label', label);
  }
  for (const button of injectedAddButtons()) {
    button.textContent = t('content.addEntry');
    button.title = t('content.addEntryTitle');
  }
}

// ---------------------------------------------------------------- Scheduling

/** The pending sweep; non-null means one is already scheduled. */
let sweepTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Schedule a sweep, merging concurrent triggers into one.
 *
 * @param delay how many milliseconds to delay; the periodic fallback uses 0, DOM changes use the default
 */
function scheduleSweep(delay = 250): void {
  if (sweepTimer) return;
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    try {
      injectPostButtons();
    } catch (e) {
      console.warn('[sloppy-mod-checklist] sweep failed', e);
    }
  }, delay);
}

/** Content script entry point: set the language, mount the overlay, start persistence, inject buttons, watch for DOM changes. */
function main(): void {
  // The language is decided first: `initLocale` pins the first frame synchronously from the system
  // language, then reads the user setting from storage. The subscription goes on before that -- if
  // the language changes between those two steps, the injected text has to refresh along with it
  // (`relabelInjected` is a no-op for elements that don't exist yet, so subscribing first has no
  // side effects).
  subscribeLocale(relabelInjected);
  void initLocale();

  mountOverlay();
  startAutoPersist();
  startExternalSync();
  void checklistStore.getState().hydrate();

  ensureFab();
  injectPostButtons();
  // The two above used the language as of the moment they were built; if initLocale's storage read
  // happens to land right after (the user picked a non-system language on the settings page), this
  // one refresh smooths out the difference.
  relabelInjected();

  // osu is a front-end-rendered SPA: new content can be inserted at any time, so MutationObserver + a periodic fallback
  new MutationObserver(() => scheduleSweep()).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  setInterval(() => scheduleSweep(0), 2000);

  const count = safeQueryAll(document, SELECTORS.discussion).length;
  console.info(
    `[sloppy-mod-checklist] content script ready (found ${count} discussions` +
      (count === 0 ? '; if the site has been redesigned, please update locators.ts' : '') +
      ')',
  );
}

main();
