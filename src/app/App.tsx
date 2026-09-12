import { useState } from 'react';
import type { MessageKey } from '../i18n';
import { useLocale } from '../i18n/react';
import { ToastHost } from '../components/toast';
import { EXT_NAME } from '../shared/extension';
import { ChecklistView } from './ChecklistView';
import { SettingsView } from './SettingsView';

type TabKey = 'checklist' | 'settings';

/**
 * The two tabs in the top bar. Stores keys, not text: a module-level constant is evaluated
 * once at script load, so calling `t()` here would bake in whatever the language was at that
 * moment, and switching the UI language later wouldn't change it.
 */
const TABS: ReadonlyArray<{ key: TabKey; labelKey: MessageKey }> = [
  { key: 'checklist', labelKey: 'nav.checklist' },
  { key: 'settings', labelKey: 'nav.settings' },
];

/** The full Checklist app: top bar + tabs (CODING_PLAN §5.1). */
export function App() {
  const [tab, setTab] = useState<TabKey>('checklist');
  const { t } = useLocale();

  return (
    <div className="app">
      <header className="app__topbar">
        <div className="app__brand">
          <span className="app__logo" aria-hidden="true">
            ✓
          </span>
          <span className="app__brandname">{EXT_NAME}</span>
        </div>
        <nav className="app__tabs" aria-label={t('nav.aria')}>
          {TABS.map((tabDef) => (
            <button
              key={tabDef.key}
              type="button"
              // The smoke test clicks tabs by this attribute: looking them up by text breaks
              // the moment the UI language changes (same reason as LanguagePanel's
              // `data-role="locale-select"`).
              data-tab={tabDef.key}
              className={`app__tab${tab === tabDef.key ? ' app__tab--active' : ''}`}
              aria-current={tab === tabDef.key ? 'page' : undefined}
              onClick={() => setTab(tabDef.key)}
            >
              {t(tabDef.labelKey)}
            </button>
          ))}
        </nav>
      </header>

      {tab === 'checklist' ? <ChecklistView /> : <SettingsView />}

      <ToastHost />
    </div>
  );
}
