import { useLocale } from '../i18n/react';
import { AboutPanel } from './AboutPanel';
import { DataPanel } from './DataPanel';
import { LanguagePanel } from './LanguagePanel';
import { SyncPanel } from './SyncPanel';

/**
 * Settings page. UI language + data (export/import/clear) + sync (WebDAV from M5; OAuth in M6),
 * with attribution at the bottom.
 */
export function SettingsView() {
  const { t } = useLocale();
  return (
    <main className="app__main">
      <h1 className="view__title">{t('settings.title')}</h1>
      <LanguagePanel />
      <DataPanel />
      <SyncPanel />
      <AboutPanel />
    </main>
  );
}
