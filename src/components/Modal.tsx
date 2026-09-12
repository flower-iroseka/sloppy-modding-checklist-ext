import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useLocale } from '../i18n/react';
import { focusablesIn, trapTarget } from './focusTrap';

export interface ModalProps {
  /** Whether the modal is open. */
  open: boolean;
  /** The line of text in the title bar. */
  title: string;
  /** Request close: clicking the ✕ in the top right, clicking the overlay and pressing Esc all end up here. */
  onClose(): void;
  /** The modal body. */
  children: ReactNode;
  /** The bottom button area; no footer when it isn't passed. */
  footer?: ReactNode;
  /** The element to focus when it opens (defaults to the first focusable element in the panel) */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
}

/**
 * Generic modal (CODING_PLAN §5.3).
 *
 * No portal: the content script mounts it inside a shadow root, and portaling to
 * document.body would escape the shadow and lose style isolation, whereas rendering in place
 * works in both contexts.
 */
export function Modal({ open, title, onClose, children, footer, initialFocusRef }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const { t } = useLocale();

  // `onClose` is a new function literal on every render (callers write inline arrows), so it
  // can't go into the dependency list of the effect below: once it does, every re-render of
  // the parent "unmounts and reopens" the modal -- focus is yanked back to the first input,
  // which is most obvious while the user is typing.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    // After closing, focus has to go back to the button that opened it. Otherwise focus drops
    // back to <body> and keyboard users have to Tab all the way from the start to get back to
    // where they were.
    // (In the content script the modal lives inside a shadow root, where `activeElement` is
    //  the host element -- focusing that is correct too: the keyboard continues from this
    //  block rather than from the top of the page.)
    const opener = document.activeElement as HTMLElement | null;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const next = trapTarget(focusablesIn(panelRef.current), document.activeElement, e.shiftKey);
      // Only take over at the two ends; let the middle positions through so the browser follows its own order (see focusTrap.ts)
      if (next) {
        e.preventDefault();
        next.focus();
      }
    };
    // capture: get in before the osu page's own Esc / Tab handling
    document.addEventListener('keydown', onKeyDown, true);

    const target =
      initialFocusRef?.current ??
      panelRef.current?.querySelector<HTMLElement>(
        'input, textarea, button, [href], select, [tabindex]:not([tabindex="-1"])',
      );
    target?.focus();

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (opener && opener.isConnected) opener.focus();
    };
  }, [open, initialFocusRef]);

  if (!open) return null;

  return (
    <div
      className="mc-modal"
      role="presentation"
      onMouseDown={(e) => {
        // Only close when the click is on the overlay itself (not inside the panel)
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Deliberately doesn't lock body scrolling. The overlay itself is `position: fixed` +
          `overflow: auto`, so whether the background can scroll is secondary; and in the
          content script we're modifying someone else's page body, so if it ever fails to be
          restored (the modal gets force-unmounted, the extension crashes), the osu page can
          never scroll again and the user has no way to tell why. */}
      <div
        className="mc-modal__panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="mc-modal__head">
          <h2 className="mc-modal__title" id={titleId}>
            {title}
          </h2>
          <button
            type="button"
            className="mc-modal__close"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            ✕
          </button>
        </div>
        <div className="mc-modal__body">{children}</div>
        {footer ? <div className="mc-modal__foot">{footer}</div> : null}
      </div>
    </div>
  );
}
