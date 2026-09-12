import { downloadText, mergeDocs, parseDocJson, serializeDoc } from '../core/exchange';
import { flushPersist } from '../core/persist';
import { checklistStore } from '../core/store';
import { readDoc, removeDoc, writeDoc } from '../core/storage';
import { renderMsg, type Locale, type Msg } from '../i18n';
import { readDndTrace } from './dndTrace';

/**
 * Dev / automation debug hook: only under `app.html?debug=1` does it attach the core API to
 * `window.__mc`, for the end-to-end smoke tests (scripts/smoke-*.mjs) to drive real
 * chrome.storage persistence. Without the query param it isn't mounted, so normal use doesn't
 * expose it.
 */
export function exposeDevApi(): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  if (params.get('debug') !== '1') return;

  Object.defineProperty(window, '__mc', {
    configurable: true,
    value: {
      store: checklistStore,
      state: () => checklistStore.getState(),
      doc: () => checklistStore.getState().doc,
      addEntry: (input: Parameters<ReturnType<typeof checklistStore.getState>['addEntry']>[0]) =>
        checklistStore.getState().addEntry(input),
      updateEntry: (...args: Parameters<ReturnType<typeof checklistStore.getState>['updateEntry']>) =>
        checklistStore.getState().updateEntry(...args),
      removeEntry: (id: string) => checklistStore.getState().removeEntry(id),
      moveEntry: (...args: Parameters<ReturnType<typeof checklistStore.getState>['moveEntry']>) =>
        checklistStore.getState().moveEntry(...args),
      clearAll: () => checklistStore.getState().clearAll(),
      flush: () => flushPersist(),
      serialize: () => serializeDoc(checklistStore.getState().doc),
      parse: (text: string) => parseDocJson(text),
      merge: (incoming: Parameters<typeof mergeDocs>[1]) =>
        mergeDocs(checklistStore.getState().doc, incoming),
      download: (text: string) => downloadText('modding-checklist-debug.json', text),
      storage: { readDoc, writeDoc, removeDoc },
      /**
       * Render a `Msg` into actual text.
       *
       * What the smoke scripts assert on is "the sentence the user sees", while the core layer and
       * the SW hand the page a struct (`{ key, params }`) -- the script has no catalog available in
       * Node, so it can only borrow the page's realm to render.
       *
       * @param msg the template to render
       * @param locale render in this language; defaults to the current UI language, so what the
       *   script asserts is the same sentence the user sees
       */
      render: (msg: Msg, locale?: Locale) => renderMsg(msg, locale),
      /** The most recent drag's active/over (e2e uses it to explain where things landed). */
      dnd: () => readDndTrace(),
    },
  });
  console.info('[osu-mod-checklist] dev API exposed at window.__mc (debug=1)');
}
