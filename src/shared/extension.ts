/** Extension name, reused across popup / app / content (so it isn't hardcoded in each place). */
export const EXT_NAME = 'osu! Modding Checklist';

/** Path of app.html inside the extension package (relative to the extension root). */
const APP_PAGE = 'app.html';

/**
 * Open the Checklist full-page app in a new tab (CODING_PLAN §6).
 * `chrome.tabs.create` needs no extra permission, but only works in an extension context.
 *
 * @returns resolves once the tab is created
 */
export function openChecklistPage(): Promise<void> {
  const url = chrome.runtime.getURL(APP_PAGE);
  return chrome.tabs.create({ url }).then(() => undefined);
}
