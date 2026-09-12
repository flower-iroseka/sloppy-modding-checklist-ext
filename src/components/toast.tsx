import { useSyncExternalStore } from 'react';

/** The toast's tone: success, failure, plain notice. */
export type ToastKind = 'ok' | 'error' | 'info';

interface ToastItem {
  /** An auto-incrementing number used to tell apart multiple toasts at the same moment. */
  id: number;
  /** The tone, which decides the live region it lands in. */
  kind: ToastKind;
  /** The text to show; already translated. */
  text: string;
}

/**
 * Minimal toast (CODING_PLAN §1.2 "保存 → 轻提示").
 * Module-level subscription; the app page and the content script each hold their own
 * instance without interfering with each other.
 */
/** The toasts currently on screen, oldest first. */
let items: readonly ToastItem[] = [];
/** The roots that have a ToastHost mounted; they re-read items when notified. */
const listeners = new Set<() => void>();
/** The id for the next toast, only ever increases. */
let seq = 0;

function emit(): void {
  for (const l of listeners) l();
}

/**
 * Show a toast; it disappears on its own after a while.
 *
 * @param text the text to display (already translated)
 * @param kind the tone; `error` goes into the assertive region and interrupts what the screen reader is reading
 * @param ms how long it stays, in milliseconds
 */
export function showToast(text: string, kind: ToastKind = 'ok', ms = 2600): void {
  const id = ++seq;
  items = [...items, { id, kind, text }];
  emit();
  setTimeout(() => {
    items = items.filter((t) => t.id !== id);
    emit();
  }, ms);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): readonly ToastItem[] {
  return items;
}

/** The toast host, mounted at the page root. A page only needs one. */
export function ToastHost() {
  const list = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // polite and assertive are region-level attributes and a container can only pick one; and
  // the two kinds of toast deserve different weight anyway -- "已保存" is a casual mention
  // that shouldn't interrupt what the screen reader is reading, while "复制失败" is
  // information the next step depends on and has to be able to cut in. So two regions.
  const calm = list.filter((t) => t.kind !== 'error');
  const urgent = list.filter((t) => t.kind === 'error');

  return (
    // The outer element is persistent and both regions are persistent: a live region has to
    // exist in the DOM first and get text added later for screen readers to announce it. If
    // the region were only mounted once there's a toast, "the region appeared" and "text
    // appeared inside it" would happen in the same frame and most screen readers would miss
    // the whole thing. (Empty regions have their space collapsed by CSS.)
    <div className="mc-toasts">
      <div className="mc-toasts__region" role="status" aria-live="polite" data-live="polite">
        {calm.map((t) => (
          <div key={t.id} className={`mc-toast mc-toast--${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
      <div className="mc-toasts__region" role="alert" aria-live="assertive" data-live="assertive">
        {urgent.map((t) => (
          <div key={t.id} className={`mc-toast mc-toast--${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
