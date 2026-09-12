import { describe, expect, it } from 'vitest';
import { createEmptyDoc } from '../src/core/doc';
import { SyncError } from '../src/core/sync/errors';
import type { DirHandleLike, FileHandleLike, FolderPermission } from '../src/core/sync/folderHandle';
import { createLocalFolderProvider } from '../src/core/sync/localFolder';
import { bindProvider, runPull, runPush, type SyncDeps } from '../src/core/sync/manager';
import { catalogEntry, createProviders, PROVIDER_CATALOG } from '../src/core/sync/registry';
import type { ChecklistDoc } from '../src/core/types';
import type { LocalFolderConfig, ProviderConfig } from '../src/core/sync/types';
import { renderKey } from '../src/i18n';

/**
 * The "local sync folder" provider (§7.7).
 *
 * The fakes here are more work than the others': those inject a `fetch`, this one injects
 * a directory handle. `fakeDir` is an in-memory folder behind the same minimal interface
 * as a real `FileSystemDirectoryHandle` (the `DirHandleLike` in `folderHandle.ts`), so the
 * provider code under test is real -- only the filesystem is fake.
 */

const FILE = 'modding-checklist.json';

interface FakeFile {
  /** The file's contents. */
  json: string;
  /** A fake last-modified time; conflict detection reads it. */
  mtime: number;
}

interface FakeWorld {
  /** The fake directory handle, standing in for a real DirHandleLike. */
  dir: DirHandleLike;
  /** The files currently in the folder; reads and writes both land here. */
  files: Map<string, FakeFile>;
  /**
   * Make the next open throw.
   *
   * @param name the file name to break
   * @param err the error to throw
   */
  failGetWith(name: string, err: unknown): void;
  /**
   * Make the next `createWritable` throw.
   *
   * @param err the error to throw
   */
  failOpen(err: unknown): void;
  /**
   * Make the next `close` throw, simulating a failure partway through a write
   * (the contents won't be persisted).
   *
   * @param err the error to throw
   */
  failClose(err: unknown): void;
  /** What each `write` received, in call order. */
  written: string[];
  /** The number of successful `close` calls. */
  closed: number;
  /** The number of times `abort` was called. */
  aborted: number;
  /** The file names `getFileHandle` was asked for, in call order. */
  getCalls: string[];
}

/**
 * Build an in-memory folder.
 *
 * Reads and writes all land on the `files` Map and never touch the real filesystem;
 * `failGetWith` / `failOpen` / `failClose` are used to trip the various error branches.
 *
 * @param files files placed up front, which this fake directory mutates directly
 * @param name directory name, which is what `LocalFolderConfig.folderName` uses
 * @returns the fake directory handle and its call log
 */
function fakeDir(files: Map<string, FakeFile> = new Map(), name = 'MyDrive'): FakeWorld {
  let getError: { name: string; err: unknown } | null = null;
  let openError: unknown = null;
  let closeError: unknown = null;
  const world: FakeWorld = {
    files,
    written: [],
    closed: 0,
    aborted: 0,
    getCalls: [],
    failGetWith(n, err) {
      getError = { name: n, err };
    },
    failOpen(err) {
      openError = err;
    },
    failClose(err) {
      closeError = err;
    },
    dir: {
      name,
      async getFileHandle(n: string, options?: { create?: boolean }): Promise<FileHandleLike> {
        world.getCalls.push(n);
        if (getError && getError.name === n) {
          const e = getError.err;
          getError = null;
          throw e;
        }
        if (!files.has(n)) {
          if (!options?.create) throw notFound();
          files.set(n, { json: '', mtime: 0 });
        }
        return {
          async getFile() {
            const f = files.get(n);
            if (!f) throw notFound();
            return { text: async () => f.json, lastModified: f.mtime };
          },
          async createWritable() {
            if (openError) {
              const e = openError;
              openError = null;
              throw e;
            }
            let buffer = '';
            return {
              async write(data: string) {
                world.written.push(data);
                buffer += data;
              },
              async close() {
                if (closeError) {
                  const e = closeError;
                  closeError = null;
                  throw e;
                }
                world.closed += 1;
                files.set(n, { json: buffer, mtime: Date.now() });
              },
              async abort() {
                world.aborted += 1;
              },
            };
          },
        };
      },
    },
  };
  return world;
}

/**
 * Build a DOM NotFoundError.
 *
 * @returns an Error named `NotFoundError`, since the code branches on the name
 */
function notFound(): unknown {
  return Object.assign(new Error('A requested file or directory could not be found.'), {
    name: 'NotFoundError',
  });
}

/**
 * Build a DOM error with the given name.
 *
 * @param name the DOMException name, e.g. `NotAllowedError`
 * @returns an Error with a matching name
 */
function domError(name: string): unknown {
  return Object.assign(new Error(name), { name });
}

/**
 * Assemble a provider plus a few switches for steering its dependencies.
 *
 * @param opts.files files placed up front in the fake folder
 * @param opts.permission the starting permission state, defaulting to `granted`
 * @returns the provider, the config, and two switches for dropping the handle / changing permission
 */
function setup(opts: { files?: Map<string, FakeFile>; permission?: FolderPermission } = {}) {
  const world = opts.files ? fakeDir(opts.files) : fakeDir();
  let permission: FolderPermission | null = opts.permission ?? 'granted';
  let handle: DirHandleLike | null = world.dir;
  const provider = createLocalFolderProvider({
    load: async () => handle,
    permissionOf: async () => permission ?? 'granted',
  });
  const cfg: LocalFolderConfig = { enabled: true, folderName: world.dir.name };
  return {
    world,
    provider,
    cfg,
    dropHandle: () => {
      handle = null;
    },
    loseHandle(perm: FolderPermission | null) {
      permission = perm;
    },
    asConfig(): ProviderConfig {
      return cfg;
    },
  };
}

// ---------------------------------------------------------------- Config

describe('本地同步文件夹 · isConfigured', () => {
  it('选了文件夹才算配好', () => {
    const { provider } = setup();
    expect(provider.isConfigured({ enabled: true, folderName: 'MyDrive' })).toBe(true);
  });

  it('没选文件夹 / 名字是空白 → 没配好', () => {
    const { provider } = setup();
    expect(provider.isConfigured({ enabled: true })).toBe(false);
    expect(provider.isConfigured({ enabled: true, folderName: '   ' })).toBe(false);
  });

  it('关掉了 → 没配好（哪怕名字还在）', () => {
    const { provider } = setup();
    expect(provider.isConfigured({ enabled: false, folderName: 'MyDrive' })).toBe(false);
  });
});

// ---------------------------------------------------------------- Test connection

describe('本地同步文件夹 · test', () => {
  it('文件夹打得开 + 权限在 → 通过', async () => {
    const { provider, cfg } = setup();
    await expect(provider.test(cfg)).resolves.toBeUndefined();
  });

  // On the first sync the file obviously doesn't exist -- that's not a failure, and
  // treating it as one would lock everyone out.
  it('文件还没上传过 → 仍然算通过（只是远端还没有）', async () => {
    const { provider, cfg } = setup();
    await expect(provider.test(cfg)).resolves.toBeUndefined();
  });

  it('没有 folderName → 让用户去选文件夹', async () => {
    const { provider } = setup();
    await expect(provider.test({ enabled: true })).rejects.toThrow(/还没有选择同步文件夹/);
  });

  it('句柄丢了（扩展数据被清过）→ 让用户重新选，而不是说「连接正常」', async () => {
    const s = setup();
    s.dropHandle();
    const err = await s.provider.test(s.cfg).catch((e: Error) => e as SyncError);
    expect(err).toBeInstanceOf(SyncError);
    expect((err as Error).message).toMatch(/重新选择/);
  });

  it('权限退回了 prompt → 指向「重新授权」那个按钮', async () => {
    const s = setup({ permission: 'prompt' });
    await expect(s.provider.test(s.cfg)).rejects.toThrow(/重新授权/);
  });

  it('权限被拒 → 说清是「拒绝」，并给出站点设置这条后路', async () => {
    const s = setup({ permission: 'denied' });
    await expect(s.provider.test(s.cfg)).rejects.toThrow(/拒绝/);
  });
});

// ---------------------------------------------------------------- Read

describe('本地同步文件夹 · read', () => {
  it('文件不存在 → 返回 null（不是错误）', async () => {
    const { provider, cfg } = setup();
    await expect(provider.read(cfg)).resolves.toBeNull();
  });

  it('读回 JSON 与 lastModified（冲突判定要用它）', async () => {
    const files = new Map([[FILE, { json: '{"a":1}', mtime: 1712345678000 }]]);
    const { provider, cfg } = setup({ files });
    const doc = await provider.read(cfg);
    expect(doc?.json).toBe('{"a":1}');
    expect(doc?.modifiedAt).toBe(1712345678000);
  });

  it('权限不够时读不了，也不需要去碰文件', async () => {
    const s = setup({ permission: 'prompt' });
    await expect(s.provider.read(s.cfg)).rejects.toThrow(/重新授权/);
  });
});

// ---------------------------------------------------------------- Write

describe('本地同步文件夹 · write', () => {
  it('文件不存在就建一个，写完 close（close 才真正落盘）', async () => {
    const { provider, cfg, world } = setup();
    await provider.write(cfg, '{"x":2}');
    expect(world.closed).toBe(1);
    expect(world.files.get(FILE)?.json).toBe('{"x":2}');
  });

  it('文件已存在就覆盖', async () => {
    const files = new Map([[FILE, { json: '{"old":1}', mtime: 1 }]]);
    const { provider, cfg, world } = setup({ files });
    await provider.write(cfg, '{"new":2}');
    expect(world.files.get(FILE)?.json).toBe('{"new":2}');
  });

  // A half-written file is worse than no file: the other device would read invalid JSON
  // and report a parse error that has nothing to do with the real cause (disk / permission).
  it('写到一半失败 → abort，把文件还原成写入前的样子', async () => {
    const files = new Map([[FILE, { json: '{"old":1}', mtime: 1 }]]);
    const s = setup({ files });
    s.world.failClose(new Error('disk full'));

    await expect(s.provider.write(s.cfg, '{"new":2}')).rejects.toThrow(/disk full/);
    expect(s.world.aborted).toBe(1);
    expect(s.world.files.get(FILE)?.json).toBe('{"old":1}');
  });

  it('建文件时被拒（NotAllowedError）→ 指向「重新授权」', async () => {
    const s = setup();
    s.world.failGetWith(FILE, domError('NotAllowedError'));
    await expect(s.provider.write(s.cfg, '{}')).rejects.toThrow(/重新授权/);
  });

  it('文件被别的程序占着 → 标成可重试，别让用户去改配置', async () => {
    const s = setup();
    s.world.failOpen(domError('NoModificationAllowedError'));
    const err = (await s.provider.write(s.cfg, '{}').catch((e: Error) => e)) as SyncError;
    expect(err).toBeInstanceOf(SyncError);
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/稍后重试/);
  });

  // Something with that name is a directory -- the user most likely picked the wrong folder
  // by accident, and the error should say so.
  it('那个名字被一个文件夹占了 → 提示换文件夹', async () => {
    const s = setup();
    s.world.failGetWith(FILE, domError('TypeMismatchError'));
    await expect(s.provider.write(s.cfg, '{}')).rejects.toThrow(/换一个同步文件夹/);
  });
});

// ---------------------------------------------------------------- Wired into the registry

describe('本地同步文件夹 · 注册表', () => {
  // Being first = the default option the settings page gives new users (`SyncPanel` takes
  // `PROVIDER_CATALOG[0]`). This isn't an arbitrary order: the other four all require the
  // user to go register / configure something elsewhere first, and only this one doesn't.
  it('它是目录里的第一项，也就是新用户看到的默认同步方式', () => {
    expect(PROVIDER_CATALOG[0].id).toBe('localFolder');
  });

  it('它在目录里没有 origins —— 一个 host 权限都不该要', () => {
    const desc = catalogEntry('localFolder');
    expect(desc).toBeDefined();
    expect(desc?.origins).toBeUndefined();
    expect(desc?.oauth).toBeUndefined();
  });

  it('createProviders 真的把它造了出来，且能过一遍读写', async () => {
    const providers = createProviders({
      fetch: (() => Promise.reject(new Error('不该发请求'))) as unknown as typeof fetch,
      launchWebAuthFlow: async () => undefined,
      tokens: { get: async () => undefined, set: async () => {}, clear: async () => {} },
      folder: {
        load: async () => ({
          name: 'My Drive',
          async getFileHandle() {
            return {
              async getFile() {
                return { text: async () => '{"from":"disk"}', lastModified: 7 };
              },
              async createWritable() {
                return { async write() {}, async close() {} };
              },
            };
          },
        }),
        permissionOf: async () => 'granted' as const,
      },
    });

    const provider = providers.localFolder;
    expect(provider).toBeDefined();
    // `displayName` stores a key (since M9, see the SyncProvider comment), so translate
    // first and then compare: what's being compared is still "the name the user sees on the
    // settings page".
    expect(renderKey(provider!.displayName, undefined, 'zh')).toBe('本地同步文件夹');
    await expect(provider?.read({ enabled: true, folderName: 'My Drive' })).resolves.toEqual({
      json: '{"from":"disk"}',
      modifiedAt: 7,
    });
  });
});

// ---------------------------------------------------------------- Combining with the sync flow

describe('本地同步文件夹 · 接到 manager 上', () => {
  /**
   * Build a doc with one general-internal entry.
   *
   * @param updatedAt timestamp for the doc and that entry
   * @param summary the entry's summary, also folded into its id
   * @param deviceId device name, defaulting to d-local
   * @returns the built doc
   */
  function doc(updatedAt: number, summary: string, deviceId = 'd-local'): ChecklistDoc {
    const d = createEmptyDoc(deviceId, updatedAt);
    d.updatedAt = updatedAt;
    d.cells['general-internal'].push({
      id: `e-${summary}`,
      scope: 'general',
      source: 'internal',
      summary,
      links: [],
      createdAt: updatedAt,
      updatedAt,
    });
    return d;
  }

  /**
   * Wire the local folder provider into the manager's deps.
   *
   * @param files the files in that folder; reads and writes both land here
   * @param local this device's local doc, which `state.local` references
   * @returns the fake folder, the readable/writable local doc, and the assembled deps
   */
  function makeDeps(files: Map<string, FakeFile>, local: ChecklistDoc) {
    const world = fakeDir(files);
    const provider = createLocalFolderProvider({
      load: async () => world.dir,
      permissionOf: async () => 'granted',
    });
    const state = { local };
    const deps: SyncDeps = {
      provider: bindProvider(provider, { enabled: true, folderName: world.dir.name }),
      strategy: 'newest-wins',
      now: () => 1_700_000_000_000,
      readLocalDoc: async () => state.local,
      writeLocalDoc: async (d) => {
        state.local = d;
      },
      backup: async () => 'backup',
    };
    return { world, state, deps };
  }

  // The manager-side logic is already tested (sync-manager.test.ts); these two prove one
  // thing: that logic holds just as well for "remote = a local folder", with no special
  // case needed for it.
  it('本地更新 → 内容真的落到那个文件夹里的 JSON 上', async () => {
    const files = new Map<string, FakeFile>();
    const d = makeDeps(files, doc(2, 'hello'));
    expect((await runPush(d.deps)).action).toBe('push');

    const onDisk = JSON.parse(files.get(FILE)?.json ?? '{}') as {
      cells: Record<string, { summary: string }[]>;
    };
    expect(onDisk.cells['general-internal'][0].summary).toBe('hello');
  });

  it('拉取读的就是文件夹里那一份', async () => {
    const files = new Map<string, FakeFile>();
    await runPush(makeDeps(files, doc(5, 'from-other-device')).deps);

    // Switch to another device: local is empty, and the folder still holds what the
    // previous device wrote.
    const fresh = makeDeps(files, doc(1, 'local-only'));
    expect((await runPull(fresh.deps)).action).toBe('pull');
    expect(fresh.state.local.cells['general-internal'][0].summary).toBe('from-other-device');
  });
});
