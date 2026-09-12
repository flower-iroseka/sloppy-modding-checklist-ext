/**
 * The sync layer's data model (CODING_PLAN §7.1).
 *
 * A provider doesn't touch storage or the store, it only knows "a JSON string": what's read
 * from the remote and what's about to be uploaded are both just text to it. That keeps
 * WebDAV's offline/401/missing-path concerns separate from the "which copy wins" conflict
 * logic, so each can be unit-tested on its own.
 */
import type { MessageKey, Msg } from '../../i18n';

/** The three sync methods currently implemented. */
export type ProviderId = 'localFolder' | 'webdav' | 'dropbox';

/** The part all three provider configs share. */
export interface ProviderConfigBase {
  /** Whether the user turned it on in the settings page. Nothing syncs when it's off. */
  enabled: boolean;
}

/** WebDAV: manually entered server address + basic auth. */
export interface WebDavConfig extends ProviderConfigBase {
  /**
   * Collection URL, e.g. `https://dav.jianguoyun.com/dav/`; the file name is fixed, see
   * REMOTE_FILE.
   */
  baseUrl: string;
  /** basic auth username. */
  username: string;
  /** basic auth password. */
  password: string;
  /**
   * Subdirectory under the collection (can be empty). Trailing slashes are optional and
   * normalized.
   */
  path?: string;
}

/**
 * The two OAuth providers (M6): the user enters the client_id they registered in each
 * provider's console.
 *
 * The flow is authorization code + PKCE, so client_secret isn't required -- Microsoft's and
 * Dropbox's public clients shouldn't have one at all, and filling one in just adds another
 * surface to leak. The field stays because it's a property of the client type (only
 * confidential clients require it), decided per provider by `OAuthSpec.requiresSecret`, and
 * both are currently false.
 *
 * The token isn't here: that's runtime data, stored under another key (`syncTokens`), read
 * and written only by the service worker (§7.6). This config does end up in exported
 * settings, and the token must never travel with it.
 */
export interface OAuthConfig extends ProviderConfigBase {
  /** The client id obtained after registering the app in each provider's console. */
  clientId: string;
  /** Only needed by confidential clients; leave empty for public clients. */
  clientSecret?: string;
  /** Extra fixed params on the authorization request. */
  extra?: Record<string, string>;
}

/**
 * Local sync folder (M7): the user picks a local folder that a cloud drive client is syncing
 * with `showDirectoryPicker`, the extension writes a JSON into it, and getting it to the
 * cloud is the client's job.
 *
 * The directory handle isn't here -- `FileSystemDirectoryHandle` can't go into
 * `chrome.storage` (it isn't JSON, only structured cloning can move it), so the handle lives
 * in the extension origin's IndexedDB (`folderHandle.ts`). This config keeps only a name, to
 * show "which folder is currently connected" on the settings page, and to give a sensible
 * error when there's no handle.
 *
 * And precisely because it holds no credentials, it's the only one of the providers that
 * needs no host permission, no developer console, and no app registration (the other one
 * needing no host permission is WebDAV, but that still requires the user to have a WebDAV-
 * capable cloud drive account).
 */
export interface LocalFolderConfig extends ProviderConfigBase {
  /** For display; the handle that actually does the work is in IndexedDB. */
  folderName?: string;
}

/** The union of the three provider configs. */
export type ProviderConfig = LocalFolderConfig | WebDavConfig | OAuthConfig;

/** What's read from the remote. */
export interface RemoteDoc {
  /** The file's raw text. */
  json: string;
  /**
   * The remote file's modification time (ms). Only used as a fallback clock when the doc has
   * no updatedAt.
   */
  modifiedAt?: number;
}

/**
 * What one sync method has to implement. Upload, pull and conflict detection all go through
 * just these methods.
 */
export interface SyncProvider {
  /** Which provider this implementation handles; it's registered under this id. */
  id: ProviderId;
  /**
   * The name shown to the user; stores a key, not a string.
   *
   * It gets dropped into sentences like `err.bg.notConfigured` as the `{provider}` param, and
   * those sentences have to follow the UI language. Storing a pre-rendered Chinese name
   * would give you "Local sync folder is not fully configured yet" with a Chinese name
   * wedged in after switching to English. Brand names (WebDAV / Dropbox) each take a key
   * too, with the same value in both catalogs, so call sites don't have to branch on "this
   * one translates, that one doesn't".
   */
  displayName: MessageKey;
  /**
   * Whether the config is filled in completely (no network).
   *
   * @param cfg this provider's config
   * @returns true when it's filled in
   */
  isConfigured(cfg: ProviderConfig): boolean;
  /**
   * "测试连接": reachable, authenticated, directory exists → resolve.
   *
   * @param cfg this provider's config
   * @throws {SyncError} any step didn't go through
   */
  test(cfg: ProviderConfig): Promise<void>;
  /**
   * Read the remote doc.
   *
   * @param cfg this provider's config
   * @returns the remote doc; null when there's no remote file yet (not an error)
   * @throws {SyncError} network or authentication failure
   */
  read(cfg: ProviderConfig): Promise<RemoteDoc | null>;
  /**
   * Write the doc to the remote, overwriting what's there.
   *
   * @param cfg this provider's config
   * @param docJson the raw JSON to write up
   * @throws {SyncError} network or authentication failure
   */
  write(cfg: ProviderConfig, docJson: string): Promise<void>;
}

/**
 * Conflict strategy (§7.2). With `ask`, SyncManager doesn't decide on its own; it hands back
 * to the UI for the user to choose.
 */
export type SyncStrategy = 'newest-wins' | 'local-wins' | 'remote-wins' | 'ask';

/** User config. Written only by the settings page. */
export interface SyncSettings {
  /** The currently selected sync method; null before the user has picked one. */
  activeProvider: ProviderId | null;
  /** Each provider's own config. Providers never configured have no entry. */
  config: Partial<Record<ProviderId, ProviderConfig>>;
  /** Auto-upload after data changes. */
  autoSync: boolean;
  /** Pull when the extension opens (only really pulls if it's been over 10 minutes). */
  pullOnStart: boolean;
  /** What to do when both sides changed. */
  strategy: SyncStrategy;
}

/**
 * Runtime status. Written by the service worker, read-only for the settings page.
 *
 * Stored separately from `SyncSettings` on purpose: the status changes on every sync, and
 * mixed into the same object, every read by the settings page could collide with the version
 * the SW is writing (a read-modify-write would put back the user's just-entered config).
 */
export interface SyncStatus {
  /** Last sync time (ms). Absent when it's never synced. */
  lastSyncAt?: number;
  /**
   * Why the last attempt failed; cleared after a success.
   *
   * Stores a structured `Msg`, not a rendered sentence: this data sits in storage
   * indefinitely, and when the user switches UI language and opens the settings page again,
   * it has to change language along with it (see i18n/types.ts).
   * Before M9 it stored a Chinese string, which gets wrapped in `err.raw` on read (see
   * normalizeSyncStatus).
   */
  lastError?: Msg;
  /** The last successful action, used for "last sync: upload/pull". */
  lastAction?: 'push' | 'pull';
  /**
   * A pull hit a conflict that can't be decided automatically; the UI needs to ask the user.
   */
  pendingConflict?: PendingConflict;
}

/** The conflict scene when the user has to make the call. */
export interface PendingConflict {
  /**
   * Which kind of conflict -- the two ask different questions:
   * `push` is "the remote is newer, are you sure you want to overwrite it with the local
   * copy" (confirm/cancel),
   * `pull` is "the two sides differ, which copy do you keep" (keep local/use remote/merge).
   */
  kind: 'push' | 'pull';
  /** The remote doc's raw JSON, used when choosing "use remote" / "merge". */
  remoteJson: string;
  /** The remote doc's updatedAt (ms). */
  remoteUpdatedAt: number;
  /** The local doc's updatedAt; the local doc is taken straight from the store. */
  localUpdatedAt: number;
}
