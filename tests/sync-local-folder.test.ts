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

describe('local sync folder · isConfigured', () => {
  it('only counts as configured once a folder is picked', () => {
    const { provider } = setup();
    expect(provider.isConfigured({ enabled: true, folderName: 'MyDrive' })).toBe(true);
  });

  it('no folder picked / blank name -> not configured', () => {
    const { provider } = setup();
    expect(provider.isConfigured({ enabled: true })).toBe(false);
    expect(provider.isConfigured({ enabled: true, folderName: '   ' })).toBe(false);
  });

  it('turned off -> not configured (even if the name is still there)', () => {
    const { provider } = setup();
    expect(provider.isConfigured({ enabled: false, folderName: 'MyDrive' })).toBe(false);
  });
});

// ---------------------------------------------------------------- Test connection

describe('local sync folder · test', () => {
  it('the folder opens and permission is granted -> passes', async () => {
    const { provider, cfg } = setup();
    await expect(provider.test(cfg)).resolves.toBeUndefined();
  });

  // On the first sync the file obviously doesn't exist -- that's not a failure, and
  // treating it as one would lock everyone out.
  it('the file has not been uploaded yet -> still passes (the remote just has nothing yet)', async () => {
    const { provider, cfg } = setup();
    await expect(provider.test(cfg)).resolves.toBeUndefined();
  });

  it('no folderName -> send the user to pick a folder', async () => {
    const { provider } = setup();
    await expect(provider.test({ enabled: true })).rejects.toThrow(/还没有选择同步文件夹/);
  });

  it('the handle is gone (extension data was cleared) -> ask the user to pick again, not say "connection is fine"', async () => {
    const s = setup();
    s.dropHandle();
    const err = await s.provider.test(s.cfg).catch((e: Error) => e as SyncError);
    expect(err).toBeInstanceOf(SyncError);
    expect((err as Error).message).toMatch(/重新选择/);
  });

  it('permission fell back to prompt -> point at the "re-authorize" button', async () => {
    const s = setup({ permission: 'prompt' });
    await expect(s.provider.test(s.cfg)).rejects.toThrow(/重新授权/);
  });

  it('permission denied -> say "denied" plainly, and offer site settings as the way out', async () => {
    const s = setup({ permission: 'denied' });
    await expect(s.provider.test(s.cfg)).rejects.toThrow(/拒绝/);
  });
});

// ---------------------------------------------------------------- Read

describe('local sync folder · read', () => {
  it('the file is missing -> returns null (not an error)', async () => {
    const { provider, cfg } = setup();
    await expect(provider.read(cfg)).resolves.toBeNull();
  });

  it('reads back the JSON and lastModified (conflict detection needs it)', async () => {
    const files = new Map([[FILE, { json: '{"a":1}', mtime: 1712345678000 }]]);
    const { provider, cfg } = setup({ files });
    const doc = await provider.read(cfg);
    expect(doc?.json).toBe('{"a":1}');
    expect(doc?.modifiedAt).toBe(1712345678000);
  });

  it('cannot read without permission, and does not need to touch the file', async () => {
    const s = setup({ permission: 'prompt' });
    await expect(s.provider.read(s.cfg)).rejects.toThrow(/重新授权/);
  });
});

// ---------------------------------------------------------------- Write

describe('local sync folder · write', () => {
  it('creates the file if missing, then closes (close is what really flushes to disk)', async () => {
    const { provider, cfg, world } = setup();
    await provider.write(cfg, '{"x":2}');
    expect(world.closed).toBe(1);
    expect(world.files.get(FILE)?.json).toBe('{"x":2}');
  });

  it('overwrites when the file already exists', async () => {
    const files = new Map([[FILE, { json: '{"old":1}', mtime: 1 }]]);
    const { provider, cfg, world } = setup({ files });
    await provider.write(cfg, '{"new":2}');
    expect(world.files.get(FILE)?.json).toBe('{"new":2}');
  });

  // A half-written file is worse than no file: the other device would read invalid JSON
  // and report a parse error that has nothing to do with the real cause (disk / permission).
  it('a failure midway -> abort, restoring the file to what it was before the write', async () => {
    const files = new Map([[FILE, { json: '{"old":1}', mtime: 1 }]]);
    const s = setup({ files });
    s.world.failClose(new Error('disk full'));

    await expect(s.provider.write(s.cfg, '{"new":2}')).rejects.toThrow(/disk full/);
    expect(s.world.aborted).toBe(1);
    expect(s.world.files.get(FILE)?.json).toBe('{"old":1}');
  });

  it('denied while creating (NotAllowedError) -> point at "re-authorize"', async () => {
    const s = setup();
    s.world.failGetWith(FILE, domError('NotAllowedError'));
    await expect(s.provider.write(s.cfg, '{}')).rejects.toThrow(/重新授权/);
  });

  it('the file is held by another program -> mark it retryable, do not send the user to the config', async () => {
    const s = setup();
    s.world.failOpen(domError('NoModificationAllowedError'));
    const err = (await s.provider.write(s.cfg, '{}').catch((e: Error) => e)) as SyncError;
    expect(err).toBeInstanceOf(SyncError);
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/稍后重试/);
  });

  // Something with that name is a directory -- the user most likely picked the wrong folder
  // by accident, and the error should say so.
  it('a folder took that name -> suggest a different folder', async () => {
    const s = setup();
    s.world.failGetWith(FILE, domError('TypeMismatchError'));
    await expect(s.provider.write(s.cfg, '{}')).rejects.toThrow(/换一个同步文件夹/);
  });
});

// ---------------------------------------------------------------- Wired into the registry

describe('local sync folder · registry', () => {
  // Being first = the default option the settings page gives new users (`SyncPanel` takes
  // `PROVIDER_CATALOG[0]`). This isn't an arbitrary order: the other four all require the
  // user to go register / configure something elsewhere first, and only this one doesn't.
  it('it is the first entry in the catalog, i.e. the default sync method a new user sees', () => {
    expect(PROVIDER_CATALOG[0].id).toBe('localFolder');
  });

  it('it has no origins in the catalog -- it should ask for zero host permissions', () => {
    const desc = catalogEntry('localFolder');
    expect(desc).toBeDefined();
    expect(desc?.origins).toBeUndefined();
    expect(desc?.oauth).toBeUndefined();
  });

  it('createProviders really does build it, and it gets through a read/write round', async () => {
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

describe('local sync folder · wired up to the manager', () => {
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
  it('a local update -> the content really lands in the JSON file in that folder', async () => {
    const files = new Map<string, FakeFile>();
    const d = makeDeps(files, doc(2, 'hello'));
    expect((await runPush(d.deps)).action).toBe('push');

    const onDisk = JSON.parse(files.get(FILE)?.json ?? '{}') as {
      cells: Record<string, { summary: string }[]>;
    };
    expect(onDisk.cells['general-internal'][0].summary).toBe('hello');
  });

  it('a pull reads exactly the copy in the folder', async () => {
    const files = new Map<string, FakeFile>();
    await runPush(makeDeps(files, doc(5, 'from-other-device')).deps);

    // Switch to another device: local is empty, and the folder still holds what the
    // previous device wrote.
    const fresh = makeDeps(files, doc(1, 'local-only'));
    expect((await runPull(fresh.deps)).action).toBe('pull');
    expect(fresh.state.local.cells['general-internal'][0].summary).toBe('from-other-device');
  });
});
