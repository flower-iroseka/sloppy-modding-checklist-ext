import { afterEach, describe, expect, it, vi } from 'vitest';
import { autoPull } from '../src/background/sync';
import { createEmptyDoc } from '../src/core/doc';
import { flushPersist } from '../src/core/persist';
import { SYNC_SETTINGS_KEY, SYNC_STATUS_KEY } from '../src/core/sync/settings';
import { SYNC_TOKENS_KEY } from '../src/core/sync/tokens';
import { checklistStore } from '../src/core/store';
import { createMemoryStorage, resetStore, type MemoryStorage } from './helpers';

/**
 * Who is allowed to act while a conflict is parked.
 *
 * `autoPush` refuses to run until the user answers the conflict prompt. `autoPull` has to
 * refuse too: when the remote is strictly newer the pull goes through, and recording that
 * success rebuilds the sync status without `pendingConflict` -- the prompt would disappear
 * on its own and take the local edits it was asking about with it.
 *
 * The guard was missing until 2026-10-01. Nothing caught it because `src/background/sync.ts`
 * had no unit test at all; the smoke script only exercises the timed paths end to end.
 */

/**
 * Settings for the one provider that goes to the network, fully filled in, so the only thing
 * that can stop a run is the guard.
 *
 * It has to be Dropbox: the premise of both assertions below is that a run which gets past
 * the guard really does reach `fetch`, and the local sync folder never sends a request at
 * all, which would make them pass whether or not the guard existed.
 */
const SETTINGS = {
  activeProvider: 'dropbox',
  autoSync: true,
  config: {
    dropbox: { enabled: true, clientId: 'cid-test' },
  },
};

/**
 * An unexpired Dropbox token, so `accessToken` hands it straight back.
 *
 * Without this the read would look for a token, find none, and throw before reaching the
 * network -- the same "stops early" outcome the guard produces, which is exactly what the
 * positive control below has to rule out.
 */
const TOKENS = {
  dropbox: { accessToken: 'at-test', expiresAt: Date.now() + 3_600_000 },
};

/**
 * Put a real document into storage and into the store.
 *
 * Both matter: `readLocalDoc` reads storage (and throws "no local data yet" when it is
 * empty), while the conflict panel reads the store. A test that only reset the store would
 * have `syncPull` bail out before it ever looked at the network, and the assertions below
 * would pass whether or not the guard existed.
 *
 * @param storage the in-memory storage to seed
 * @returns the same storage
 */
async function seedLocalDoc(storage: MemoryStorage): Promise<MemoryStorage> {
  resetStore(storage);
  await checklistStore.getState().hydrate();
  checklistStore.getState().addEntry({ scope: 'general', source: 'internal', summary: 'x' });
  await flushPersist();
  return storage;
}

/** Storage holding settings, a local document, and a push conflict nobody has answered. */
async function storageWithConflict(): Promise<MemoryStorage> {
  const storage = createMemoryStorage({
    [SYNC_SETTINGS_KEY]: SETTINGS,
    [SYNC_TOKENS_KEY]: TOKENS,
    [SYNC_STATUS_KEY]: {
      lastSyncAt: 1_000,
      pendingConflict: {
        kind: 'push',
        remoteJson: JSON.stringify(createEmptyDoc('d-remote', 2_000)),
        remoteUpdatedAt: 2_000,
        localUpdatedAt: 1_000,
      },
    },
  });
  return seedLocalDoc(storage);
}

describe('autoPull with a conflict the user has not answered', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The two assertions belong together. "The conflict is still parked" on its own would pass
  // even without the guard -- a pull that fails also leaves it alone. What only the guard can
  // produce is a run that never reached the network, and that is what keeps the conflict.
  it('does not go to the network, so the conflict stays parked', async () => {
    const storage = await storageWithConflict();
    const fetchSpy = vi.fn(() => Promise.reject(new Error('the network should not be touched')));
    vi.stubGlobal('fetch', fetchSpy);

    await autoPull('alarm');

    expect(fetchSpy).not.toHaveBeenCalled();
    const status = storage.dump()[SYNC_STATUS_KEY] as { pendingConflict?: unknown };
    expect(status.pendingConflict).toBeDefined();
  });

  // Without this one the guard could pass by never pulling at all, which would be a worse
  // bug than the one it fixes.
  it('still pulls when nothing is parked', async () => {
    await seedLocalDoc(
      createMemoryStorage({
        [SYNC_SETTINGS_KEY]: SETTINGS,
        [SYNC_TOKENS_KEY]: TOKENS,
        [SYNC_STATUS_KEY]: { lastSyncAt: 1_000 },
      }),
    );
    const fetchSpy = vi.fn(() => Promise.reject(new Error('network is down')));
    vi.stubGlobal('fetch', fetchSpy);

    await autoPull('alarm');

    // The request rejects, so this run fails -- what matters is that it got as far as the
    // network instead of stopping at the guard.
    expect(fetchSpy).toHaveBeenCalled();
  });
});
