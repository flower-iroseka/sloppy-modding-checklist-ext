import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initLocale } from '../i18n';
import '../styles/theme.css';
import './popup.css';
import { PopupApp } from './PopupApp';

// Popup entry point. The language has to be in place before the first render, and same as
// app/main.tsx we kick it off without waiting -- the popup lives for a frame, it can't afford to
// wait.
void initLocale();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PopupApp />
  </StrictMode>,
);
