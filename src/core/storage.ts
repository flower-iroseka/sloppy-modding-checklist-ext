import { normalizeDoc } from './doc';
import type { ChecklistDoc } from './types';

/** chrome.storage.local key: the whole document. */
export const DOC_KEY = 'checklist';

/**
 * A minimal storage abstraction, so unit tests can inject a mock; under MV3 it's backed by
 * chrome.storage.local.
 */
export interface StorageArea {
  /**
   * @param keys the keys to read; omitted or null reads all of them
   * @returns the values that were found, keyed by key
   */
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
  /** @param items the keys and values to write */
  set(items: Record<string, unknown>): Promise<void>;
  /** @param keys the keys to delete */
  remove(keys: string | string[]): Promise<void>;
}

/** The injected storage implementation; null means it isn't set yet and we grab chrome's on demand */
let backend: StorageArea | null = null;

/**
 * For injecting in tests / non-extension environments.
 *
 * @param area the storage implementation to use; pass null to go back to the default
 */
export function setStorageBackend(area: StorageArea | null): void {
  backend = area;
}

/** @returns a wrapper around chrome.storage.local; null when the API isn't available. */
function chromeStorageArea(): StorageArea | null {
  const local = globalThis.chrome?.storage?.local;
  if (!local) return null;
  return {
    get: (keys) => local.get(keys as string | string[]),
    set: (items) => local.set(items),
    remove: (keys) => local.remove(keys),
  };
}

/**
 * @returns the storage implementation to use right now
 * @throws {Error} no backend was injected and chrome.storage.local isn't available either
 */
export function getStorageArea(): StorageArea {
  if (!backend) {
    const area = chromeStorageArea();
    if (!area) {
      throw new Error('chrome.storage.local 不可用；测试环境请先调用 setStorageBackend()');
    }
    backend = area;
  }
  return backend;
}

// ---------------------------------------------------------------- Generic key read/write

/**
 * Read and write a single value by key. Besides the document (`checklist`) there are sync
 * settings, sync status and the pre-pull backup, and they all go through the same backend
 * -- otherwise unit tests would have to inject several mocks and would likely miss one.
 *
 * @param key the key to read
 * @returns the stored value, or null when the key doesn't exist
 */
export async function readKey(key: string): Promise<unknown> {
  const bag = await getStorageArea().get(key);
  const raw = bag?.[key];
  return raw === undefined ? null : raw;
}

/**
 * @param key the key to write
 * @param value the value to store
 */
export async function writeKey(key: string, value: unknown): Promise<void> {
  await getStorageArea().set({ [key]: value });
}

/** @param key the key to delete */
export async function removeKey(key: string): Promise<void> {
  await getStorageArea().remove(key);
}

/**
 * Subscribe to writes to a key from somewhere else (under MV3 the app page, popup and
 * content script each have their own JS realm and talk to each other through storage
 * events). In non-extension environments (unit tests / SSR) it quietly returns a no-op.
 *
 * @param key the key to watch
 * @param cb callback when a write comes in; the argument is the raw newValue
 * @returns a function that unsubscribes
 */
export function onKeyChanged(key: string, cb: (raw: unknown) => void): () => void {
  const api = globalThis.chrome?.storage?.onChanged;
  if (!api) return () => {};
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ): void => {
    if (areaName !== 'local') return;
    const change = changes[key];
    if (!change) return;
    cb(change.newValue);
  };
  api.addListener(listener);
  return () => api.removeListener(listener);
}

// ---------------------------------------------------------------- Document

/**
 * Read the document.
 *
 * @returns the document, or null when nothing was stored yet; stored content is normalized
 *   on the way out, so individual bad entries are dropped
 * @throws {DocValidationError} what was stored has an invalid structure
 */
export async function readDoc(): Promise<ChecklistDoc | null> {
  const raw = await readKey(DOC_KEY);
  if (raw === null) return null;
  return normalizeDoc(raw);
}

/** @param doc the document to write */
export async function writeDoc(doc: ChecklistDoc): Promise<void> {
  await writeKey(DOC_KEY, doc);
}

export async function removeDoc(): Promise<void> {
  await removeKey(DOC_KEY);
}

/**
 * Subscribe to document changes (see `onKeyChanged`).
 *
 * @param cb callback when a write comes in; the argument is the raw document
 * @returns a function that unsubscribes
 */
export function onDocChanged(cb: (raw: unknown) => void): () => void {
  return onKeyChanged(DOC_KEY, cb);
}
