import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { startAutoPersist, startExternalSync } from '../core/persist';
import { checklistStore } from '../core/store';
import { initLocale } from '../i18n';
import { exposeDevApi } from '../shared/devtools';
import '../styles/theme.css';
import '../styles/ui.css';
import './app.css';
import { App } from './App';

/**
 * Entry point for the app page: settle the first-frame language, wire up persistence and
 * external sync, then render.
 */

// Language has to be set up first, and without awaiting its promise: `initLocale` first
// settles the first frame's language synchronously from the system language, then reads the
// user setting from storage (overriding it makes subscribers re-render). Awaiting it would
// make the first frame an empty "language not decided yet" string.
void initLocale();

// Startup order: hydrate first (storage -> store), then render; the persistence and external
// sync listeners can be attached in parallel.
startAutoPersist();
startExternalSync();
void checklistStore.getState().hydrate();
exposeDevApi();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
