import { beforeEach, describe, expect, it } from 'vitest';
import {
  defaultSyncSettings,
  normalizeLocalFolderConfig,
  normalizeSyncSettings,
  normalizeSyncStatus,
  normalizeWebDavConfig,
  readSyncSettings,
  writeSyncSettings,
} from '../src/core/sync/settings';
import { renderMsg } from '../src/i18n';
import { resetStore } from './helpers';

/**
 * Sync settings: normalizing stored config, and the read / write pair wrapped around it.
 *
 * Normalizing runs on every read, so it's the last line of defense against whatever an
 * older version wrote -- and it has to keep another provider's filled-in credentials,
 * rather than wipe them because the user switched away once.
 */

describe('normalizeWebDavConfig', () => {
  it('baseUrl loses its trailing slash (added once when building the file name, never stored twice)', () => {
    expect(normalizeWebDavConfig({ baseUrl: 'https://dav.example.com/dav///' }).baseUrl).toBe(
      'https://dav.example.com/dav',
    );
  });

  it('path loses the slashes at both ends', () => {
    expect(normalizeWebDavConfig({ path: '/osu/' }).path).toBe('osu');
    expect(normalizeWebDavConfig({ path: '   ' }).path).toBe('');
  });

  it('whitespace in the password must be kept as-is (trimming it would break the login)', () => {
    expect(normalizeWebDavConfig({ password: ' ab cd ' }).password).toBe(' ab cd ');
  });

  it('username is trimmed, and a missing field is an empty string rather than undefined', () => {
    const cfg = normalizeWebDavConfig({ username: '  me  ' });
    expect(cfg.username).toBe('me');
    expect(cfg.password).toBe('');
    expect(cfg.baseUrl).toBe('');
    expect(cfg.enabled).toBe(false);
  });

  it('garbage input does not throw', () => {
    expect(normalizeWebDavConfig(null).baseUrl).toBe('');
    expect(normalizeWebDavConfig('nope').username).toBe('');
    expect(normalizeWebDavConfig(42).password).toBe('');
  });
});

describe('normalizeLocalFolderConfig', () => {
  // The handle lives in IndexedDB and the config only holds the name -- so there's very
  // little to normalize here, and the trimmed name is exactly what matters: it's the only
  // basis for telling whether a folder was ever picked.
  it('keeps just a display name, trimmed', () => {
    expect(normalizeLocalFolderConfig({ enabled: true, folderName: '  My Drive  ' })).toEqual({
      enabled: true,
      folderName: 'My Drive',
    });
  });

  it('a blank / missing name means the whole field is absent (not an empty string)', () => {
    expect(normalizeLocalFolderConfig({ enabled: true, folderName: '   ' })).toEqual({
      enabled: true,
    });
    expect(normalizeLocalFolderConfig({}).folderName).toBeUndefined();
  });

  // Regression guard: after the value is written to storage, `normalizeSyncSettings` runs
  // it through again, and an empty string left in there would make the UI show a "has a
  // name" state.
  it('garbage input does not throw', () => {
    expect(normalizeLocalFolderConfig(null).folderName).toBeUndefined();
    expect(normalizeLocalFolderConfig(42).enabled).toBe(false);
  });

  it('it does not interfere with other providers configs (switching provider does not wipe the folder name)', () => {
    const s = normalizeSyncSettings({
      activeProvider: 'webdav',
      config: {
        localFolder: { enabled: true, folderName: 'My Drive' },
        webdav: { enabled: true, baseUrl: 'https://a.com/dav', username: 'u', password: 'p' },
      },
    });
    expect((s.config.localFolder as { folderName?: string }).folderName).toBe('My Drive');
    expect((s.config.webdav as { username: string }).username).toBe('u');
  });
});

describe('normalizeSyncSettings', () => {
  it('non-object -> defaults', () => {
    expect(normalizeSyncSettings(null)).toEqual(defaultSyncSettings());
    expect(normalizeSyncSettings('x')).toEqual(defaultSyncSettings());
  });

  it('an unknown provider name is dropped', () => {
    expect(normalizeSyncSettings({ activeProvider: 'ftp' }).activeProvider).toBeNull();
  });

  it('an unknown strategy name falls back to newest-wins', () => {
    expect(normalizeSyncSettings({ strategy: 'mine-wins' }).strategy).toBe('newest-wins');
  });

  // Deliberate: wiping another provider's filled-in clientId / password just because the
  // user switched providers once would drive them crazy.
  it('a non-active provider config is kept too', () => {
    const s = normalizeSyncSettings({
      activeProvider: 'webdav',
      config: {
        webdav: { enabled: true, baseUrl: 'https://a.com/dav', username: 'u', password: 'p' },
        dropbox: { enabled: true, clientId: 'cid-123' },
      },
    });
    expect(s.activeProvider).toBe('webdav');
    expect((s.config.dropbox as { clientId: string }).clientId).toBe('cid-123');
  });

  // Google Drive was cut entirely on 2026-09-11. Old profiles may still hold its config
  // and `activeProvider: 'googleDrive'` -- on read, the former is dropped and the latter
  // falls back to null (the page then lands on the first item in the catalog). It must not
  // throw: not being able to open the settings page after one upgrade is the worst outcome.
  it('a removed provider config is dropped, activeProvider falls back to null', () => {
    const s = normalizeSyncSettings({
      activeProvider: 'googleDrive',
      config: { googleDrive: { enabled: true, clientId: 'cid-123' } },
    });
    expect(s.activeProvider).toBeNull();
    expect(s.config).toEqual({});
  });

  it('a provider never configured leaves no empty shell in config', () => {
    const s = normalizeSyncSettings({ config: { webdav: { baseUrl: 'https://a.com' } } });
    expect(Object.keys(s.config)).toEqual(['webdav']);
  });

  it('boolean fields only accept a real true', () => {
    const s = normalizeSyncSettings({ autoSync: 'yes', pullOnStart: 1 });
    expect(s.autoSync).toBe(false);
    expect(s.pullOnStart).toBe(false);
  });
});

describe('normalizeSyncStatus', () => {
  it('garbage values -> empty status (not a throw)', () => {
    expect(normalizeSyncStatus(null)).toEqual({});
    expect(normalizeSyncStatus({ lastError: '' })).toEqual({});
    expect(normalizeSyncStatus({ lastAction: 'merge' })).toEqual({});
  });

  it('keeps the valid fields', () => {
    const normalized = normalizeSyncStatus({
      lastSyncAt: 123,
      lastAction: 'pull',
      lastError: 'boom',
    });
    expect(normalized.lastSyncAt).toBe(123);
    expect(normalized.lastAction).toBe('pull');
    // Older versions stored a rendered string, which normalization wraps as an `err.raw`
    // `Msg` (see normalizeStoredError). What's asserted here is "that sentence still reads
    // the same", not what shape it's wrapped into internally -- the shape is a means, the
    // user seeing "boom" is the point.
    expect(renderMsg(normalized.lastError!, 'zh')).toBe('boom');
  });

  it('pendingConflict is dropped entirely when remoteJson is missing or kind is wrong', () => {
    expect(normalizeSyncStatus({ pendingConflict: { kind: 'push' } }).pendingConflict).toBeUndefined();
    expect(
      normalizeSyncStatus({ pendingConflict: { kind: 'merge', remoteJson: '{}' } }).pendingConflict,
    ).toBeUndefined();
  });

  it('a missing pendingConflict timestamp is filled with 0 (not undefined)', () => {
    const st = normalizeSyncStatus({ pendingConflict: { kind: 'pull', remoteJson: '{}' } });
    expect(st.pendingConflict).toEqual({
      kind: 'pull',
      remoteJson: '{}',
      remoteUpdatedAt: 0,
      localUpdatedAt: 0,
    });
  });
});

describe('syncSettings read / write', () => {
  beforeEach(() => {
    resetStore();
  });

  it('reads defaults when nothing was ever written', async () => {
    expect(await readSyncSettings()).toEqual(defaultSyncSettings());
  });

  it('writing then reading back gives the same thing (normalization included)', async () => {
    await writeSyncSettings({
      ...defaultSyncSettings(),
      activeProvider: 'webdav',
      autoSync: true,
      strategy: 'ask',
      config: {
        webdav: { enabled: true, baseUrl: 'https://a.com/dav/', username: 'u', password: 'p' },
      },
    });
    const back = await readSyncSettings();
    expect(back.activeProvider).toBe('webdav');
    expect(back.autoSync).toBe(true);
    expect(back.strategy).toBe('ask');
    expect((back.config.webdav as { baseUrl: string }).baseUrl).toBe('https://a.com/dav');
  });
});
