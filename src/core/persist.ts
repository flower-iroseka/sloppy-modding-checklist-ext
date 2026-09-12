import { normalizeDoc } from './doc';
import { checklistStore } from './store';
import { onDocChanged, writeDoc } from './storage';
import type { ChecklistDoc } from './types';

/**
 * Auto-persist: store change -> debounced write to chrome.storage.local (CODING_PLAN §2.2).
 * Flush immediately before the page is hidden or unloaded, so the last change isn't lost.
 */

/** Write debounce window, in milliseconds. */
const DEFAULT_DEBOUNCE_MS = 300;

let timer: ReturnType<typeof setTimeout> | null = null;
/** Last doc reference the subscription saw; a change means the store swapped the document */
let lastDoc = checklistStore.getState().doc;
/** The doc reference last confirmed written to disk; different from the current doc = unwritten changes */
let lastWrittenDoc: ChecklistDoc = checklistStore.getState().doc;
/** The write promise chain, so concurrent flushes queue up instead of racing */
let chain: Promise<void> = Promise.resolve();
/** startAutoPersist's cancel function, which also doubles as the "already started" flag */
let stop: (() => void) | null = null;
/** startExternalSync's cancel function, same as above */
let stopExternal: (() => void) | null = null;

/** Turn a thrown thing into one line the user can read. */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Whether there are local changes not yet written to disk. */
export function isPersistDirty(): boolean {
  return checklistStore.getState().doc !== lastWrittenDoc;
}

/**
 * Record that this document now matches storage -- after a successful write, or after
 * adopting an external change.
 *
 * @param doc the document that is now in sync with storage
 */
export function markPersisted(doc: ChecklistDoc): void {
  lastDoc = doc;
  lastWrittenDoc = doc;
}

async function writeCurrent(): Promise<void> {
  const state = checklistStore.getState();
  if (!state.hydrated) return;
  // Skip the write when there are no unwritten changes. This guards against frozen
  // background tabs: while frozen the tab gets no storage events and still holds the old
  // document, so a flush on wake-up would overwrite what was just written elsewhere. With
  // real local changes doc !== lastWrittenDoc, so the write still happens and "local
  // changes win" holds.
  if (!isPersistDirty()) return;
  const { doc } = state;
  state.setSaving(true);
  try {
    await writeDoc(doc);
    lastWrittenDoc = doc;
    checklistStore.getState().markSaved(Date.now());
  } catch (e) {
    checklistStore.getState().setError(errorMessage(e));
  } finally {
    checklistStore.getState().setSaving(false);
  }
}

/**
 * Write the current document to storage right away. Writes are serialized, to avoid
 * concurrent overwrites.
 *
 * @returns a promise that settles when this write finishes
 */
export function flushPersist(): Promise<void> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  chain = chain.then(writeCurrent, writeCurrent);
  return chain;
}

/**
 * Start watching and auto-persisting.
 *
 * @param debounceMs how long after changes stop before writing, 300ms by default
 * @returns a function that cancels the watch and clears the pending timer; repeated calls
 *   return the same one
 */
export function startAutoPersist(debounceMs: number = DEFAULT_DEBOUNCE_MS): () => void {
  if (stop) return stop;

  const unsubscribe = checklistStore.subscribe((state) => {
    if (!state.hydrated) return;
    if (state.doc === lastDoc) return;
    lastDoc = state.doc;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void flushPersist();
    }, debounceMs);
  });

  // Node (unit tests) has no DOM: keep only the subscription + manual flush.
  const hasDom = typeof document !== 'undefined' && typeof globalThis.addEventListener === 'function';

  const onHidden = () => {
    if (document.visibilityState === 'hidden') void flushPersist();
  };
  const onPageHide = () => void flushPersist();

  if (hasDom) {
    document.addEventListener('visibilitychange', onHidden);
    globalThis.addEventListener('pagehide', onPageHide);
  }

  stop = () => {
    unsubscribe();
    if (hasDom) {
      document.removeEventListener('visibilitychange', onHidden);
      globalThis.removeEventListener('pagehide', onPageHide);
    }
    if (timer) clearTimeout(timer);
    timer = null;
    stop = null;
  };
  return stop;
}

/**
 * Adopt a document change coming from another context (another extension page /
 * content script).
 *
 * Two rules, so multiple contexts don't overwrite each other and lose data: don't adopt
 * while there are unwritten local changes (local changes win, and the next write puts
 * them back over the remote), and don't adopt when the remote updatedAt isn't newer than
 * local, which also swallows the echo of our own write.
 *
 * @param raw the raw document from the storage event
 * @returns whether it was actually adopted, handy for callers and tests to assert on
 */
export function applyExternalDoc(raw: unknown): 'applied' | 'ignored' {
  const state = checklistStore.getState();
  if (!state.hydrated) return 'ignored';

  let incoming: ChecklistDoc;
  try {
    incoming = normalizeDoc(raw);
  } catch {
    return 'ignored';
  }
  if (isPersistDirty()) return 'ignored';
  if (incoming.updatedAt <= state.doc.updatedAt) return 'ignored';

  state.replaceDoc(incoming);
  // replaceDoc normalizes into a new object reference; go with the normalized one
  markPersisted(checklistStore.getState().doc);
  return 'applied';
}

/**
 * Subscribe to storage changes and adopt them automatically (this is how the content
 * script and the app page stay in sync in real time).
 *
 * @returns a function that unsubscribes; repeated calls return the same one
 */
export function startExternalSync(): () => void {
  if (stopExternal) return stopExternal;
  const unsubscribe = onDocChanged((raw) => {
    applyExternalDoc(raw);
  });
  stopExternal = () => {
    unsubscribe();
    stopExternal = null;
  };
  return stopExternal;
}
