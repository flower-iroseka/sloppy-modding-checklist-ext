import { useCallback, useSyncExternalStore } from 'react';
import {
  getLocaleSnapshot,
  renderMsg,
  renderMsgMarkup,
  setLocale,
  subscribeLocale,
  t,
  type Locale,
  type LocaleSetting,
  type Msg,
} from './index';

/**
 * The React binding for i18n (CODING_PLAN §14).
 *
 * It lives in its own file so that `./index.ts` keeps zero React dependencies -- the
 * service worker needs translations too, but its bundle should not contain a rendering
 * library (see the header comment in index.ts).
 */

/**
 * The return value of `useLocale()`: the current locale state plus a few render entry points.
 *
 * When the locale changes, `useSyncExternalStore` re-renders every component that uses
 * this hook, so there is no need to wrap the component tree in a Provider.
 */
export interface LocaleApi {
  /** The locale actually in use (`auto` already resolved to `zh` / `en`). */
  locale: Locale;
  /** What the user picked in Settings (possibly `auto`). */
  setting: LocaleSetting;
  /** Change the locale and persist it; other pages in the same extension follow along. */
  setLocale: (next: LocaleSetting) => void;
  /** "How do you say this in the current locale": the key plus params to fill `{name}`. This is the module-level `t`. */
  t: typeof t;
  /**
   * "How do you say this template in the current locale".
   *
   * Core code (the sync side) and the service worker send `Msg`s back to the page rather
   * than keys: the two realms may disagree on the locale, so rendering has to happen on
   * the side that is about to display it (see `shared/messages.ts`). The `notice` /
   * `error` / `lastError` the page receives are all these templates; render them with
   * this.
   *
   * @param msg the template with its key and params
   * @returns the sentence in the current locale, markers already stripped
   */
  tm: (msg: Msg) => string;
  /**
   * Same as `tm`, but it keeps the `**bold**` markers from the catalog for `<RichText>`
   * to render.
   *
   * Which one to use: visible body text goes through `tmMarkup` + `<RichText>` (the user
   * should see bold, and should never see the asterisks); announcements for screen readers
   * go through `tm` -- they cannot express bold, so the markers would just be read out as
   * two asterisks.
   *
   * @param msg the template with its key and params
   * @returns the sentence in the current locale, with its `**` markers kept for `<RichText>`
   */
  tmMarkup: (msg: Msg) => string;
}

/**
 * Subscribe to the locale state and return the render functions for the current locale.
 *
 * @returns the current locale, the setting, and `t` / `tm` / `tmMarkup` / `setLocale`
 */
export function useLocale(): LocaleApi {
  const snapshot = useSyncExternalStore(subscribeLocale, getLocaleSnapshot, getLocaleSnapshot);
  // setLocale lives at module level, so its identity never changes; wrapping it here only
  // narrows the return type to void
  const change = useCallback((next: LocaleSetting) => {
    void setLocale(next);
  }, []);
  // Keyed on the locale: when it changes the identity changes too, so a `useMemo` /
  // `useEffect` that depends on this function recomputes
  const renderTemplate = useCallback((msg: Msg) => renderMsg(msg, snapshot.locale), [snapshot.locale]);
  const renderMarkup = useCallback(
    (msg: Msg) => renderMsgMarkup(msg, snapshot.locale),
    [snapshot.locale],
  );
  return { ...snapshot, setLocale: change, t, tm: renderTemplate, tmMarkup: renderMarkup };
}
