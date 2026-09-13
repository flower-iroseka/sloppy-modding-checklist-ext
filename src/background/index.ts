// MV3 service worker. Three things:
//   1. Open extension pages (content scripts have no chrome.tabs).
//   2. Read the current logged-in user off the page (content scripts run in an isolated world, so window.currentUser is invisible to them).
//   3. Sync networking and timers (§7) -- the page doesn't touch credentials, and scheduled tasks can only be attached here.
import {
  MESSAGE_PREFIX,
  MSG_GET_USER,
  MSG_OPEN_APP,
  MSG_SYNC_CLEAR_CONFLICT,
  MSG_SYNC_CONNECT,
  MSG_SYNC_DISCONNECT,
  MSG_SYNC_PULL,
  MSG_SYNC_PUSH,
  MSG_SYNC_TEST,
  getMessageType,
  type CurrentUserResponse,
  type SyncResponse,
} from '../shared/messages';
import { DOC_KEY } from '../core/storage';
import { describeError } from '../core/sync/errors';
import { renderMsg, type Msg } from '../i18n';
import { SYNC_SETTINGS_KEY } from '../core/sync/settings';
import type { ProviderId } from '../core/sync/types';
import {
  AUTOPUSH_ALARM,
  SYNC_ALARM,
  autoPull,
  autoPush,
  clearPendingConflict,
  initSync,
  onLocalDocChanged,
  onSyncSettingsChanged,
  syncConnect,
  syncDisconnect,
  syncPull,
  syncPush,
  syncTest,
} from './sync';

/** Path of app.html inside the extension package (relative to the extension root). */
const APP_PAGE = 'app.html';

chrome.runtime.onInstalled.addListener((details) => {
  console.info(`[sloppy-mod-checklist] service worker installed (reason=${details.reason})`);
  void initSync();
});

// The SW can be recycled and spun up again at any time; alarms survive that, but "打开时拉取" has to be checked on every startup.
chrome.runtime.onStartup.addListener(() => void initSync());

// User changed sync settings -> re-arm the alarm; user changed the checklist -> schedule an auto-push.
// These have to be attached at the top level, otherwise the SW won't get them after being recycled.
//
// Both watch storage instead of expecting the page to notify: the content script writes
// `checklist` itself (the user ticking a box on an osu page is one write), and it has no reason
// and no channel to tell the SW "I just changed the data".
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[SYNC_SETTINGS_KEY]) void onSyncSettingsChanged();
  if (changes[DOC_KEY]) onLocalDocChanged();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC_ALARM) void autoPull('alarm');
  if (alarm.name === AUTOPUSH_ALARM) void autoPush();
});

/**
 * Read the `window.currentUser` that osu sets, in the page's main world.
 *
 * Content scripts run in an isolated world: they share the DOM with the page, but `window`
 * is a different object, so reading `window.currentUser` directly always gives undefined -- and
 * then "source recommendation" would always come out as external, marking the author's own
 * replies as someone else's. Only the MAIN world can read it.
 *
 * This function gets serialized by `chrome.scripting.executeScript` and sent into the page,
 * so it can't reference any outside variables.
 *
 * @returns the current logged-in user; `id` is null when logged out or the field is missing
 */
function readCurrentUserInPage(): CurrentUserResponse {
  const raw = (globalThis as { currentUser?: { id?: unknown; username?: unknown } }).currentUser;
  if (!raw || typeof raw.id !== 'number') return { id: null };
  return {
    id: raw.id,
    ...(typeof raw.username === 'string' ? { username: raw.username } : {}),
  };
}

/**
 * Messages from the page and content scripts all come in here. A branch that replies
 * asynchronously must `return true`, otherwise the message channel gets closed right away.
 */
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const type = getMessageType(message);

  if (type === MSG_OPEN_APP) {
    chrome.tabs
      .create({ url: chrome.runtime.getURL(APP_PAGE) })
      .then(() => sendResponse({ ok: true }))
      .catch((e: unknown) => sendResponse({ ok: false, error: String(e) }));
    return true; // async response, must be declared explicitly or the channel closes right away
  }

  if (type === MSG_GET_USER) {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({ id: null } satisfies CurrentUserResponse);
      return false;
    }
    chrome.scripting
      .executeScript({
        target: { tabId },
        world: 'MAIN',
        func: readCurrentUserInPage,
      })
      .then((results) => {
        sendResponse((results[0]?.result ?? { id: null }) as CurrentUserResponse);
      })
      .catch(() => sendResponse({ id: null } satisfies CurrentUserResponse));
    return true;
  }

  if (type === MSG_SYNC_TEST) {
    void respond(() => syncTest(), sendResponse);
    return true;
  }

  if (type === MSG_SYNC_PUSH) {
    const force = (message as { force?: unknown }).force === true;
    void respond(() => syncPush({ force }), sendResponse);
    return true;
  }

  if (type === MSG_SYNC_PULL) {
    const m = message as { force?: unknown; remoteJsonOverride?: unknown };
    void respond(
      () =>
        syncPull({
          force: m.force === true,
          ...(typeof m.remoteJsonOverride === 'string'
            ? { remoteJsonOverride: m.remoteJsonOverride }
            : {}),
        }),
      sendResponse,
    );
    return true;
  }

  if (type === MSG_SYNC_CLEAR_CONFLICT) {
    void respond(async () => {
      await clearPendingConflict();
      // There's nothing to show for a successful clear, so an empty string is the rendered
      // empty -- an empty `Msg` would make `renderMsg` look up a key that doesn't exist.
      return { ok: true, message: { key: 'err.raw', params: { detail: '' } } };
    }, sendResponse);
    return true;
  }

  if (type === MSG_SYNC_CONNECT) {
    const id = (message as { provider?: unknown }).provider as ProviderId;
    void respond(() => syncConnect(id), sendResponse);
    return true;
  }

  if (type === MSG_SYNC_DISCONNECT) {
    const id = (message as { provider?: unknown }).provider as ProviderId;
    void respond(() => syncDisconnect(id), sendResponse);
    return true;
  }

  // Unrecognized messages get a reply too. The real-world case here: the page is new while the
  // running SW is old (Chrome's ScriptCache feeds it the previously compiled background.js,
  // see §12.2), so a newly added message type is completely foreign to the SW. This used to
  // `return undefined`, the page got `undefined`, and all the user saw was a useless
  // "后台没有响应" -- when we could plainly say the versions don't match.
  if (type?.startsWith(MESSAGE_PREFIX)) {
    sendResponse({ ok: false, message: { key: 'err.bg.unknownMessage', params: { type } } });
    return false;
  }
  return undefined;
});

/**
 * Every sync action funnels through here: success replies `{ok:true,message,conflict?}`,
 * failure replies `{ok:false,message}` -- exceptions never cross the message boundary. If they
 * did, the page would get an Error serialized to `{}` (structured clone drops message), the user
 * would only see the word "failed", and the line that actually helps (auth rejected / path
 * doesn't exist) would be gone.
 *
 * `message` is a `Msg` template, not a rendered sentence -- the page renders it itself after
 * receiving it (see `SyncResponse`).
 *
 * @param run the sync action to actually run
 * @param sendResponse callback that sends the result back to the caller
 */
async function respond(
  run: () => Promise<{ ok: boolean; message: Msg; conflict?: unknown }>,
  sendResponse: (r: SyncResponse) => void,
): Promise<void> {
  try {
    const outcome = await run();
    sendResponse({
      ok: outcome.ok,
      message: outcome.message,
      ...(outcome.conflict ? { conflict: outcome.conflict as SyncResponse['conflict'] } : {}),
    });
  } catch (e) {
    // describeError is a pure function now (doesn't read storage, doesn't render), so it
    // basically can't throw; this fallback exists so that if it ever does, the page doesn't get
    // undefined -- then the user wouldn't even have an explanation.
    let message: Msg;
    try {
      message = describeError(e);
    } catch {
      message =
        e instanceof Error
          ? { key: 'err.sync.failedDetail', params: { detail: e.message } }
          : { key: 'err.sync.failed' };
    }
    try {
      sendResponse({ ok: false, message });
    } catch {
      // The port is already closed (page navigated away / SW recycled). Nothing else we can
      // do, so leave a trace in the log. Only the base locale can be rendered here -- it's a
      // pure log, nobody treats it as UI copy.
      console.warn('[sloppy-mod-checklist] 响应发不出去，消息端口已关闭：', renderMsg(message, 'zh'));
    }
  }
}
