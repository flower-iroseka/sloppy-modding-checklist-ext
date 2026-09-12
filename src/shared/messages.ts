// Message protocol between the content script / page and the service worker: requests going one
// way (`RuntimeMessage`), sync replies coming back (`SyncResponse`).

import type { Msg } from '../i18n';
import type { PendingConflict, ProviderId } from '../core/sync/types';

/**
 * Prefix for all message types. The SW uses it to tell "messages from this extension" apart from
 * "messages someone else sent" -- the former get a "扩展可能没重新加载" reply when unrecognized,
 * the latter are simply ignored.
 */
export const MESSAGE_PREFIX = 'mc:';

/** Open the Checklist full-page app (content scripts have no chrome.tabs, so they ask the SW). */
export const MSG_OPEN_APP = 'mc:open-app';
/** Content scripts can't see page globals, so they ask the SW to read the current logged-in user from the main world. */
export const MSG_GET_USER = 'mc:get-user';

/** Sync (§7): networking and credentials both live in the SW, the settings page only sends messages. */
export const MSG_SYNC_TEST = 'mc:sync-test';
export const MSG_SYNC_PUSH = 'mc:sync-push';
export const MSG_SYNC_PULL = 'mc:sync-pull';
export const MSG_SYNC_CLEAR_CONFLICT = 'mc:sync-clear-conflict';
/**
 * OAuth connect / disconnect. The auth flow runs in the SW: `launchWebAuthFlow` can be called from
 * a page too, but then the token would land in the page's hands, which conflicts with the
 * "credentials live only in the SW" rule (§7.6).
 */
export const MSG_SYNC_CONNECT = 'mc:sync-connect';
export const MSG_SYNC_DISCONNECT = 'mc:sync-disconnect';

export interface OpenAppMessage {
  type: typeof MSG_OPEN_APP;
}

export interface GetUserMessage {
  type: typeof MSG_GET_USER;
}

/** Try a sync connection once, only verifying credentials and paths, without touching data. */
export interface SyncTestMessage {
  type: typeof MSG_SYNC_TEST;
}

/** Push this local copy. */
export interface SyncPushMessage {
  type: typeof MSG_SYNC_PUSH;
  /** Pass true when the user has confirmed "远端更新，仍要覆盖". */
  force?: boolean;
}

/** Overwrite local with the remote. */
export interface SyncPullMessage {
  type: typeof MSG_SYNC_PULL;
  /** Pass true when the user has confirmed "本地更新，仍要覆盖". */
  force?: boolean;
  /** "Use the remote" -- sends back the copy captured during the conflict as-is, to avoid fetching it again. */
  remoteJsonOverride?: string;
}

/** Clear the conflict notice that hasn't been answered yet. */
export interface SyncClearConflictMessage {
  type: typeof MSG_SYNC_CLEAR_CONFLICT;
}

/** Run the OAuth flow once and store the token we get in the SW. */
export interface SyncConnectMessage {
  type: typeof MSG_SYNC_CONNECT;
  /** Which OAuth provider (currently only dropbox). */
  provider: ProviderId;
}

/** Disconnect, deleting the token. */
export interface SyncDisconnectMessage {
  type: typeof MSG_SYNC_DISCONNECT;
  provider: ProviderId;
}

/** Every message the page / content script can send to the SW. */
export type RuntimeMessage =
  | OpenAppMessage
  | GetUserMessage
  | SyncTestMessage
  | SyncPushMessage
  | SyncPullMessage
  | SyncClearConflictMessage
  | SyncConnectMessage
  | SyncDisconnectMessage;

/**
 * Treat any value as a message and pull out its `type` field.
 *
 * @param value whatever came in over the message channel, the type can't be trusted
 * @returns the `type` as a string; null when it isn't an object or `type` isn't a string
 */
export function getMessageType(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' ? type : null;
}

/** Every message type this extension knows, used for runtime narrowing. */
const KNOWN_TYPES: string[] = [
  MSG_OPEN_APP,
  MSG_GET_USER,
  MSG_SYNC_TEST,
  MSG_SYNC_PUSH,
  MSG_SYNC_PULL,
  MSG_SYNC_CLEAR_CONFLICT,
  MSG_SYNC_CONNECT,
  MSG_SYNC_DISCONNECT,
];

/**
 * Check whether a received value is a message from this extension.
 *
 * @param value whatever came in over the message channel, the type can't be trusted
 * @returns true means it can be used as a `RuntimeMessage`
 */
export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  const type = getMessageType(value);
  return type !== null && KNOWN_TYPES.includes(type);
}

/** Info about the current logged-in user. */
export interface CurrentUserResponse {
  /** osu user id; null when logged out or unreadable. */
  id: number | null;
  /** osu username; omitted when the page doesn't set this field. */
  username?: string;
}

/** The uniform reply for sync messages. A failure isn't an exception, it's `ok: false` + one sentence. */
export interface SyncResponse {
  /** Whether this sync went through. "Nothing to sync" counts as going through too. */
  ok: boolean;
  /**
   * The template for the sentence shown to the user (`Msg`), not rendered text.
   *
   * The SW and the page are two realms: if the SW rendered it itself, it would have to keep a
   * language state, and that state could disagree with the page's (the user just switched language
   * on the settings page, or the SW was woken by an alarm and never read the language setting), and
   * out comes "English UI, Chinese notice". Passing a template means rendering only happens in the
   * realm that's about to display it, so the two can't disagree, and the SW needs no i18n runtime
   * state at all.
   */
  message: Msg;
  /** Carries the scene along when the user needs to decide (see SyncStatus.pendingConflict). */
  conflict?: PendingConflict;
}

