import { createEmptyDoc } from '../src/core/doc';
import { setStorageBackend, type StorageArea } from '../src/core/storage';
import { checklistStore } from '../src/core/store';

/**
 * Shared helpers for the test files: the in-memory storage backend and the store reset
 * every file calls before a case.
 *
 * Both exist so a test starts from a known state without touching real extension
 * storage, and without leaving anything behind for the next test.
 */

/** An in-memory chrome.storage.local. Tests inject this instead of touching real extension storage. */
export interface MemoryStorage extends StorageArea {
  /** Copy everything currently stored, for assertions. */
  dump(): Record<string, unknown>;
}

/**
 * Create an in-memory storage.
 *
 * Reads and writes both stay in memory, and every returned value is a deep copy,
 * so tests don't leak into each other.
 *
 * @param initial keys already in storage; empty by default
 * @returns a storage you can hand straight to setStorageBackend
 */
export function createMemoryStorage(initial: Record<string, unknown> = {}): MemoryStorage {
  let data: Record<string, unknown> = structuredClone(initial);
  return {
    async get(keys) {
      if (keys === undefined || keys === null) return structuredClone(data);
      const list = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of list) {
        if (key in data) out[key] = structuredClone(data[key]);
      }
      return out;
    },
    async set(items) {
      data = { ...data, ...structuredClone(items) };
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) delete data[key];
    },
    dump: () => structuredClone(data),
  };
}

/**
 * Install the in-memory storage and reset the store to the state right after an empty
 * doc was created. Call this before each test.
 *
 * @param storage reuse an existing in-memory storage; a new one is created when omitted
 * @returns the in-memory storage this test is using
 */
export function resetStore(storage?: MemoryStorage): MemoryStorage {
  const mem = storage ?? createMemoryStorage();
  setStorageBackend(mem);
  checklistStore.setState({
    doc: createEmptyDoc('d-test', 1_000),
    hydrated: false,
    saving: false,
    lastSavedAt: undefined,
    lastError: undefined,
  });
  return mem;
}
