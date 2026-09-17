/**
 * The "local sync folder" provider (CODING_PLAN §7.7).
 *
 * The user installs a desktop client that maps a cloud drive to a local folder (Google Drive,
 * OneDrive, Nutstore, even a LAN share), picks that folder here, and the extension writes a
 * `modding-checklist.json` into it -- the client gets it to the cloud. No developer console,
 * no app registration, no client_id, no host permission, not a single network request. What
 * it costs is spelled out on the settings card: the client has to be installed and actually
 * syncing that folder, syncing happens on its schedule, and the browser can revoke permission.
 */
import type { MessageKey } from '../../i18n';
import { SyncError } from './errors';
import type { DirHandleLike, FolderPermission } from './folderHandle';
import { REMOTE_FILE } from './webdav';
import type { LocalFolderConfig, ProviderConfig, SyncProvider } from './types';

/**
 * The sync file's name.
 *
 * Kept consistent with the WebDAV / cloud drive side -- the user sees the same name when
 * switching between methods, so manual backups, comparisons and moves need no thought.
 */
const FILE_NAME = REMOTE_FILE;

/**
 * The two things this provider needs injected: loading the handle, and checking permission.
 */
export interface LocalFolderDeps {
  /** Load the directory handle picked in the page back from IndexedDB. */
  load(): Promise<DirHandleLike | null>;
  /**
   * Check permission. `queryPermission` works in the SW (measured), so this step stays in
   * the background.
   */
  permissionOf(handle: DirHandleLike): Promise<FolderPermission>;
}

/**
 * Get the `name` off an exception.
 *
 * Uses a plain string field rather than `instanceof DOMException` -- unit tests plug in
 * fake objects, and `instanceof` would classify them all as "unknown error".
 *
 * @param e the exception
 * @returns its `name`; an empty string when there isn't one
 */
function errName(e: unknown): string {
  return e && typeof e === 'object' && typeof (e as { name?: unknown }).name === 'string'
    ? (e as { name: string }).name
    : '';
}

/**
 * Turn folder-related exceptions into a sentence you can act on.
 *
 * `NotAllowedError` is the big one here, and it has to point at the "Re-authorize" button: the
 * user's only way out is to go back to the settings page and click it, and if the error
 * doesn't say so, they'll just think syncing is broken.
 *
 * @param e the exception received; returned as-is when it's already a `SyncError`
 * @param action which action is being performed (the action word's key)
 * @returns a `SyncError` you can throw directly
 */
function folderError(e: unknown, action: MessageKey): SyncError {
  if (e instanceof SyncError) return e;
  const params = { action: { key: action } };
  switch (errName(e)) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new SyncError({ key: 'err.folder.permissionRevoked', params });
    case 'NotFoundError':
      return new SyncError({ key: 'err.folder.missing', params });
    case 'NoModificationAllowedError':
    case 'InvalidStateError':
      return new SyncError({ key: 'err.folder.busy', params }, { retryable: true });
    case 'TypeMismatchError':
      return new SyncError({ key: 'err.folder.notAFile', params });
    default:
      return new SyncError({
        key: 'err.folder.other',
        params: { ...params, detail: e instanceof Error ? e.message : String(e) },
      });
  }
}

/**
 * Is this "file not found"? Corresponds to the error `getFileHandle` throws when the file
 * is missing.
 */
function isMissing(e: unknown): boolean {
  return errName(e) === 'NotFoundError';
}

/**
 * Create a "local sync folder" provider.
 *
 * @param deps loading the handle, checking permission
 * @returns a local folder provider implementing `SyncProvider`
 */
export function createLocalFolderProvider(deps: LocalFolderDeps): SyncProvider {
  /**
   * Get "the directory we can actually read and write right now".
   *
   * This runs again on every `read` / `write` / `test`, with no caching: the handle itself
   * is cheap, and permission can be revoked by the browser at any time -- if the permission
   * state were cached, the extension would innocently report "write failed" after the user
   * revokes it, instead of telling them to click "Re-authorize".
   *
   * @param cfg provider config
   * @returns a directory handle with read-write permission
   * @throws {SyncError} no folder picked, handle lost, permission denied, or
   *         re-authorization needed
   */
  async function openFolder(cfg: ProviderConfig): Promise<DirHandleLike> {
    const name = (cfg as LocalFolderConfig).folderName;
    if (!name) throw new SyncError({ key: 'err.folder.noFolder' });

    const handle = await deps.load();
    if (!handle) {
      // Config still there, handle gone -- typically the extension data got cleared, or
      // settings were imported from somewhere else. We can't pretend nothing happened, and
      // we can't say "connection is fine" either.
      throw new SyncError({ key: 'err.folder.handleLost', params: { name } });
    }

    const perm = await deps.permissionOf(handle);
    if (perm === 'denied') {
      return Promise.reject(
        new SyncError({ key: 'err.folder.denied', params: { name: handle.name } }),
      );
    }
    if (perm !== 'granted') {
      throw new SyncError({ key: 'err.folder.needsReauth', params: { name: handle.name } });
    }
    return handle;
  }

  return {
    id: 'localFolder',
    displayName: 'provider.localFolderShort',

    /**
     * Only looks at whether a folder was picked, not at permission (this method has to be
     * synchronous, and permission is async). When permission isn't enough, `test` / `read` /
     * `write` throw a line pointing at "Re-authorize", which is more accurate than anything this
     * could say.
     */
    isConfigured(cfg) {
      const c = cfg as LocalFolderConfig;
      return c.enabled && typeof c.folderName === 'string' && c.folderName.trim() !== '';
    },

    /**
     * "Test connection" here = "the folder is still there, permission is still there".
     *
     * Deliberately doesn't create a temp file to try writing: that would make a file appear
     * out of nowhere in the user's drive and then vanish, and the cloud client would run a
     * sync for it. And `queryPermission({mode:'readwrite'})` has already asked the browser
     * "can we write?", which is the most direct answer this API offers.
     */
    async test(cfg) {
      const dir = await openFolder(cfg);
      try {
        await dir.getFileHandle(FILE_NAME);
      } catch (e) {
        // Not having uploaded the file yet is a normal state, not a fault -- this pass
        // just wants to confirm the directory opens.
        if (!isMissing(e)) throw folderError(e, 'action.folderOpen');
      }
    },

    async read(cfg) {
      const dir = await openFolder(cfg);
      let file: Awaited<ReturnType<DirHandleLike['getFileHandle']>>;
      try {
        file = await dir.getFileHandle(FILE_NAME);
      } catch (e) {
        // On the first sync the file simply doesn't exist -- treat it as "no remote yet".
        if (isMissing(e)) return null;
        throw folderError(e, 'action.folderRead');
      }
      try {
        const f = await file.getFile();
        const json = await f.text();
        // `lastModified` uses 0, which nobody would care about, to mean "none":
        // `RemoteDoc.modifiedAt` is optional, and here we can actually always get a real
        // value (unless the handle is fake).
        return { json, ...(f.lastModified > 0 ? { modifiedAt: f.lastModified } : {}) };
      } catch (e) {
        throw folderError(e, 'action.folderRead');
      }
    },

    async write(cfg, docJson) {
      const dir = await openFolder(cfg);
      let writable: Awaited<ReturnType<Awaited<ReturnType<DirHandleLike['getFileHandle']>>['createWritable']>>;
      try {
        const file = await dir.getFileHandle(FILE_NAME, { create: true });
        writable = await file.createWritable();
      } catch (e) {
        throw folderError(e, 'action.folderWrite');
      }
      try {
        await writable.write(docJson);
        // `close()` is the step that actually hits disk: if it throws, the write didn't
        // happen, and that can't be swallowed.
        await writable.close();
      } catch (e) {
        // A half-written file is worse than no file (the other device would read invalid
        // JSON). Try our best to abort and restore the file to how it was before the write.
        try {
          await writable.abort?.();
        } catch {
          // It's already broken; failing to abort doesn't matter
        }
        throw folderError(e, 'action.folderWrite');
      }
    },
  };
}
