import { MSG_GET_USER, type CurrentUserResponse } from '../shared/messages';

// Reading the current logged-in osu user id through the service worker.
//
// Content scripts run in an isolated world: they share the DOM with the page, but `window` is a
// different object, so the `window.currentUser` the page script sets is invisible here. Nothing
// throws -- "source recommendation" just quietly comes out as external forever, marking the user's
// own mods as someone else's.

/** The user id we've read. undefined means not read yet (not "logged out"). */
let cached: number | undefined;
/** The in-flight request, used to merge concurrent calls into one. */
let inflight: Promise<number | undefined> | null = null;

/**
 * Get the current logged-in user id. The result is cached per page load, so a second call doesn't
 * round-trip to the SW again.
 *
 * @returns the current user id; undefined when the SW isn't available (extension disabled / missing
 *   permission) or the user isn't logged in, and the caller falls back to external on that
 */
export function getCurrentUserId(): Promise<number | undefined> {
  if (cached !== undefined) return Promise.resolve(cached);
  if (inflight) return inflight;

  inflight = new Promise<number | undefined>((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: MSG_GET_USER }, (res: CurrentUserResponse | undefined) => {
        // Read `lastError` so a failed read doesn't make Chrome log an unchecked-error warning
        void chrome.runtime.lastError;
        const id = typeof res?.id === 'number' ? res.id : undefined;
        if (id !== undefined) cached = id;
        resolve(id);
      });
    } catch (e) {
      console.warn(
        '[sloppy-mod-checklist] could not read the current user, the source suggestion falls back to external',
        e,
      );
      resolve(undefined);
    }
  }).finally(() => {
    inflight = null;
  });

  return inflight;
}

/** Test-only: clear the cache. */
export function resetCurrentUserCache(): void {
  cached = undefined;
  inflight = null;
}
