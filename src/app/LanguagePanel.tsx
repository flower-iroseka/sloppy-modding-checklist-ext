import type { Locale, MessageKey } from '../i18n';
import { LOCALES } from '../i18n';
import { useLocale } from '../i18n/react';

/**
 * Locale code to the key for the option text. Stores keys, not text, for the same reason as
 * TABS in App.tsx.
 */
const LOCALE_LABEL_KEY: Record<Locale, MessageKey> = {
  zh: 'settings.languageZh',
  en: 'settings.languageEn',
};

/**
 * UI language switch (CODING_PLAN §14).
 *
 * On its own block at the top of the settings page rather than tucked into the sync panel: it
 * governs the whole extension's UI, and it's the user's only way back -- when the UI turns into
 * a language you can't read, you have to spot this at a glance (that's also why
 * `FALLBACK_LOCALE` is English and not Chinese, see `i18n/index.ts`).
 */
export function LanguagePanel() {
  const { t, setting, setLocale } = useLocale();

  return (
    <section className="panel">
      <h2 className="panel__title">{t('settings.language')}</h2>
      <div className="row sync__row">
        <label className="mc-field__label" htmlFor="locale">
          {t('settings.language')}
        </label>
        <select
          id="locale"
          // The smoke test recognizes this anchor, don't change it casually.
          data-role="locale-select"
          className="mc-input sync__select"
          value={setting}
          onChange={(e) => setLocale(e.target.value as typeof setting)}
        >
          <option value="auto">{t('settings.languageAuto')}</option>
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {t(LOCALE_LABEL_KEY[l])}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}
