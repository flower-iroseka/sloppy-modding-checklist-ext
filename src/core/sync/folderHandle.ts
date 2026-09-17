/**
 * Storing and loading the local sync folder's "directory handle" (CODING_PLAN §7.7).
 *
 * The handle lives in IndexedDB because `FileSystemDirectoryHandle` isn't JSON and can't go
 * into `chrome.storage` -- only structured cloning moves it. Pages and the service worker
 * share one origin, so a folder picked in a page is usable from the SW right away; that split
 * is forced by the API, since `showDirectoryPicker` needs a user gesture and isn't in the SW
 * at all. Permission isn't permanent either: a restart or a revoke in site settings drops
 * `queryPermission` to `'prompt'`, and the SW can't call `requestPermission` on its own.
 */

/**
 * The minimum surface of a directory handle (real handles satisfy it structurally; unit
 * tests can plug in fakes).
 */
export interface DirHandleLike {
  /** Directory name, for display only. */
  name: string;
  /**
   * Get a handle for one file.
   *
   * @param name file name
   * @param options.create create one when the file doesn't exist; without it, it throws
   */
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
}

/** The minimum surface of a file handle. */
export interface FileHandleLike {
  /**
   * Read the file's contents; `lastModified` in the result is this local copy's
   * modification time.
   */
  getFile(): Promise<{ text(): Promise<string>; lastModified: number }>;
  /**
   * Open a writable stream.
   *
   * @param options.keepExistingData don't truncate the existing contents (defaults to
   *        false, i.e. clear and rewrite)
   */
  createWritable(options?: { keepExistingData?: boolean }): Promise<WritableLike>;
}

/** The minimum surface of a writable stream. */
export interface WritableLike {
  /** Write a chunk of data. */
  write(data: string): Promise<void>;
  /** Commit and close; not calling it means nothing was written. */
  close(): Promise<void>;
  /** Abandon this write; not every implementation provides it. */
  abort?(): Promise<void>;
}

/** The directory's permission state, same shape as `PermissionState`. */
export type FolderPermission = 'granted' | 'prompt' | 'denied';

const DB_NAME = 'mc-sync-fs';
const DB_VERSION = 1;
const STORE = 'handles';
/**
 * There's only one folder, so the key is fixed. If we ever support several, switch the key
 * to the provider id.
 */
const HANDLE_KEY = 'folder';

// ---------------------------------------------------------------- IndexedDB

/**
 * Open the IndexedDB that holds the handle; create the object store if it's missing.
 *
 * @returns the opened database
 */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('打不开存文件夹记录的数据库。'));
  });
}

/**
 * Run one transaction.
 *
 * It has to wait for `oncomplete`, not just `onsuccess`: a `put`'s success only means the
 * request was accepted, the transaction isn't committed yet. If this resolved early, a read
 * right after might read the old value -- and the failure mode for "picked a folder but it
 * didn't stick" is exactly "you have to pick it again next time", which is hard to debug.
 *
 * @param mode read-only or read-write
 * @param run the request to run inside the transaction
 * @returns the request's result; only resolves after the transaction commits
 */
function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        let out: T;
        req.onsuccess = () => {
          out = req.result;
        };
        req.onerror = () => reject(req.error ?? new Error('读写文件夹记录失败。'));
        t.oncomplete = () => {
          db.close();
          resolve(out);
        };
        t.onabort = () => {
          db.close();
          reject(t.error ?? new Error('读写文件夹记录的事务被中止。'));
        };
      }),
  );
}

/**
 * Save the directory handle the user picked.
 *
 * @param handle the handle picked in the page
 */
export async function saveFolderHandle(handle: DirHandleLike): Promise<void> {
  await tx('readwrite', (s) => s.put(handle, HANDLE_KEY));
}

/**
 * Load back the last saved handle.
 *
 * @returns the saved handle; null when nothing was saved, or when what's saved doesn't
 *          look like a handle
 */
export async function loadFolderHandle(): Promise<DirHandleLike | null> {
  const raw = await tx<unknown>('readonly', (s) => s.get(HANDLE_KEY) as IDBRequest<unknown>);
  return raw && typeof raw === 'object' && typeof (raw as DirHandleLike).name === 'string'
    ? (raw as DirHandleLike)
    : null;
}

/** Delete the stored handle (used when the user clicks "Disconnect"). */
export async function clearFolderHandle(): Promise<void> {
  await tx('readwrite', (s) => s.delete(HANDLE_KEY));
}

// ---------------------------------------------------------------- Permission

/**
 * Ask "can we read and write right now?".
 *
 * When `queryPermission` isn't available, optimistically treat it as granted: the API
 * really can be missing in edge cases (old browsers, fake handles in tests), but when it
 * genuinely can't be used, `createWritable` throws a `NotAllowedError`, and the message on
 * that path also points at "Re-authorize". Blocking pessimistically here would make a
 * perfectly usable environment unusable.
 *
 * @param handle directory handle
 * @returns the current permission state
 */
export async function folderPermission(handle: DirHandleLike): Promise<FolderPermission> {
  const fn = permissionFn(handle, 'queryPermission');
  if (!fn) return 'granted';
  try {
    const state = await fn.call(handle, { mode: 'readwrite' });
    return state === 'granted' || state === 'denied' ? state : 'prompt';
  } catch {
    return 'granted';
  }
}

/**
 * Request permission. Can only be called from an extension page and has to be inside a user
 * gesture (the function exists in the SW, but there's no gesture to attach to, so the call
 * is rejected outright). So it's only ever called from a button in `LocalFolderCard`, and
 * the SW side never touches it.
 *
 * @param handle directory handle
 * @returns the permission state after the request; `'prompt'` when the user declines or
 *          there's no gesture
 */
export async function requestFolderPermission(handle: DirHandleLike): Promise<FolderPermission> {
  const fn = permissionFn(handle, 'requestPermission');
  if (!fn) return 'granted';
  try {
    const state = await fn.call(handle, { mode: 'readwrite' });
    return state === 'granted' || state === 'denied' ? state : 'prompt';
  } catch {
    // Not inside a user gesture / the user declined -- both fall back to prompt, so the UI
    // keeps showing "Re-authorize".
    return 'prompt';
  }
}

/**
 * Fetch the `queryPermission` / `requestPermission` methods.
 *
 * Fetched dynamically instead of `handle.queryPermission` directly: these two methods
 * aren't declared in `lib.dom`'s types at all (they're part of the File System Access
 * supplement), so writing them directly won't pass tsc.
 *
 * @param handle directory handle
 * @param name which method to fetch
 * @returns that method; undefined when the handle doesn't have it
 */
function permissionFn(
  handle: DirHandleLike,
  name: 'queryPermission' | 'requestPermission',
): ((this: DirHandleLike, d: { mode: string }) => Promise<PermissionState>) | undefined {
  const fn = (handle as unknown as Record<string, unknown>)[name];
  return typeof fn === 'function'
    ? (fn as (this: DirHandleLike, d: { mode: string }) => Promise<PermissionState>)
    : undefined;
}
