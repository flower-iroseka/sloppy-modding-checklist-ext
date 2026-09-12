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
  it('baseUrl 去尾部斜杠（拼文件名时统一加，不能存两遍）', () => {
    expect(normalizeWebDavConfig({ baseUrl: 'https://dav.example.com/dav///' }).baseUrl).toBe(
      'https://dav.example.com/dav',
    );
  });

  it('path 去两端斜杠', () => {
    expect(normalizeWebDavConfig({ path: '/osu/' }).path).toBe('osu');
    expect(normalizeWebDavConfig({ path: '   ' }).path).toBe('');
  });

  it('密码里的空白必须原样保留（trim 掉就登不上了）', () => {
    expect(normalizeWebDavConfig({ password: ' ab cd ' }).password).toBe(' ab cd ');
  });

  it('用户名去两端空白，字段缺失时为空串而不是 undefined', () => {
    const cfg = normalizeWebDavConfig({ username: '  me  ' });
    expect(cfg.username).toBe('me');
    expect(cfg.password).toBe('');
    expect(cfg.baseUrl).toBe('');
    expect(cfg.enabled).toBe(false);
  });

  it('喂垃圾不抛错', () => {
    expect(normalizeWebDavConfig(null).baseUrl).toBe('');
    expect(normalizeWebDavConfig('nope').username).toBe('');
    expect(normalizeWebDavConfig(42).password).toBe('');
  });
});

describe('normalizeLocalFolderConfig', () => {
  // The handle lives in IndexedDB and the config only holds the name -- so there's very
  // little to normalize here, and the trimmed name is exactly what matters: it's the only
  // basis for telling whether a folder was ever picked.
  it('只留一个显示用的名字，两端空白去掉', () => {
    expect(normalizeLocalFolderConfig({ enabled: true, folderName: '  My Drive  ' })).toEqual({
      enabled: true,
      folderName: 'My Drive',
    });
  });

  it('名字是空白 / 缺失时整个字段不出现（而不是留一个空串）', () => {
    expect(normalizeLocalFolderConfig({ enabled: true, folderName: '   ' })).toEqual({
      enabled: true,
    });
    expect(normalizeLocalFolderConfig({}).folderName).toBeUndefined();
  });

  // Regression guard: after the value is written to storage, `normalizeSyncSettings` runs
  // it through again, and an empty string left in there would make the UI show a "has a
  // name" state.
  it('喂垃圾不抛错', () => {
    expect(normalizeLocalFolderConfig(null).folderName).toBeUndefined();
    expect(normalizeLocalFolderConfig(42).enabled).toBe(false);
  });

  it('它和别家的配置互不干扰（切 provider 不会把文件夹名字抹掉）', () => {
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
  it('非对象 → 默认值', () => {
    expect(normalizeSyncSettings(null)).toEqual(defaultSyncSettings());
    expect(normalizeSyncSettings('x')).toEqual(defaultSyncSettings());
  });

  it('未知的 provider 名字被丢掉', () => {
    expect(normalizeSyncSettings({ activeProvider: 'ftp' }).activeProvider).toBeNull();
  });

  it('未知的策略名退回 newest-wins', () => {
    expect(normalizeSyncSettings({ strategy: 'mine-wins' }).strategy).toBe('newest-wins');
  });

  // Deliberate: wiping another provider's filled-in clientId / password just because the
  // user switched providers once would drive them crazy.
  it('非活动 provider 的配置也要保留', () => {
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
  it('已删除的 provider 的配置被丢掉，activeProvider 退回 null', () => {
    const s = normalizeSyncSettings({
      activeProvider: 'googleDrive',
      config: { googleDrive: { enabled: true, clientId: 'cid-123' } },
    });
    expect(s.activeProvider).toBeNull();
    expect(s.config).toEqual({});
  });

  it('没有配过的 provider 不在 config 里留空壳', () => {
    const s = normalizeSyncSettings({ config: { webdav: { baseUrl: 'https://a.com' } } });
    expect(Object.keys(s.config)).toEqual(['webdav']);
  });

  it('布尔字段只认真正的 true', () => {
    const s = normalizeSyncSettings({ autoSync: 'yes', pullOnStart: 1 });
    expect(s.autoSync).toBe(false);
    expect(s.pullOnStart).toBe(false);
  });
});

describe('normalizeSyncStatus', () => {
  it('垃圾值 → 空状态（不是抛错）', () => {
    expect(normalizeSyncStatus(null)).toEqual({});
    expect(normalizeSyncStatus({ lastError: '' })).toEqual({});
    expect(normalizeSyncStatus({ lastAction: 'merge' })).toEqual({});
  });

  it('保留合法字段', () => {
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

  it('pendingConflict 缺 remoteJson 或 kind 不对时整个丢掉', () => {
    expect(normalizeSyncStatus({ pendingConflict: { kind: 'push' } }).pendingConflict).toBeUndefined();
    expect(
      normalizeSyncStatus({ pendingConflict: { kind: 'merge', remoteJson: '{}' } }).pendingConflict,
    ).toBeUndefined();
  });

  it('pendingConflict 的时间戳缺失时补 0（不是 undefined）', () => {
    const st = normalizeSyncStatus({ pendingConflict: { kind: 'pull', remoteJson: '{}' } });
    expect(st.pendingConflict).toEqual({
      kind: 'pull',
      remoteJson: '{}',
      remoteUpdatedAt: 0,
      localUpdatedAt: 0,
    });
  });
});

describe('syncSettings 读写', () => {
  beforeEach(() => {
    resetStore();
  });

  it('没写过时读到默认值', async () => {
    expect(await readSyncSettings()).toEqual(defaultSyncSettings());
  });

  it('写进去再读回来是同一份（含规整）', async () => {
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
