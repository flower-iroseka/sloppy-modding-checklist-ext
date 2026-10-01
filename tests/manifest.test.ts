import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { allOrigins, PROVIDER_CATALOG } from '../src/core/sync/registry';

/**
 * manifest.json against the code: the two have to be changed together.
 *
 * A missed change is hard to trace -- an OAuth request that can't go out reports a CORS
 * error or "can't connect to xxx", which looks like a network problem, and nobody would
 * suspect a missing domain in the manifest. Hence a test.
 */
const manifest = JSON.parse(
  readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8'),
) as {
  host_permissions: string[];
  optional_host_permissions?: string[];
  permissions: string[];
  content_scripts: { matches: string[] }[];
  version: string;
};

  // The version number is what makes Chrome drop the service worker's ScriptCache: after
  // changing `background/**`, clicking "reload" alone may not be enough, only a version
  // change reliably gets rid of the old SW script (see CODING_PLAN §12.2). When the two
  // files drift apart that quietly stops working -- the reload looks like it happened,
  // but the old code is still running, with the same symptoms as mixing old and new
  // builds.
  it('package.json and manifest.json versions match', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(manifest.version).toBe(pkg.version);
  });

describe('manifest.json', () => {
  it('every domain a provider declares must be in host_permissions', () => {
    const missing = allOrigins().filter((o) => !manifest.host_permissions.includes(o));
    expect(missing).toEqual([]);
  });

  // The other half. When a provider is removed (Google Drive went this way, 2026-09-11),
  // "keeping one extra domain" and "missing one domain" fail in completely different
  // ways: a missing one reports as a network problem right away and someone will
  // investigate; an extra one is totally silent -- the extension works fine, it just
  // holds a permission declaration nobody uses. This kind of leftover that "only shows
  // up when you delete something" can only be caught by a test.
  const NON_PROVIDER_ORIGINS = ['https://osu.ppy.sh/*']; // used by the content script, doesn't belong to any provider

  it('no unclaimed domain in host_permissions (leftovers from deleting a provider)', () => {
    const claimed = new Set([...allOrigins(), ...NON_PROVIDER_ORIGINS]);
    expect(manifest.host_permissions.filter((o) => !claimed.has(o))).toEqual([]);
  });

  // Two opposite assertions, both required. The ones that talk to the network must
  // declare their domains; miss one and the request can't go out, reported as a
  // "network problem". The ones that don't must have no domains; add one and the
  // extension needlessly asks the user for a permission it doesn't use -- the
  // "Read and change all your data on all websites" line at install time scares people off.
  it('every provider that goes online declares its domains, every one that does not has none', () => {
    for (const desc of PROVIDER_CATALOG) {
      if (desc.id === 'localFolder') {
        // The local sync folder sends no requests at all: once the file is written it's
        // handed off to the cloud drive client (§7.7).
        expect(desc.origins).toBeUndefined();
        continue;
      }
      expect(desc.origins?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it('every entry in host_permissions is a valid match pattern', () => {
    for (const pattern of manifest.host_permissions) {
      expect(pattern).toMatch(/^https:\/\/[^\s]+\/\*$/);
    }
  });

  // A provider whose address is typed in by the user needs this: the host is only known at
  // runtime, so it can't go in the static list. Nothing left in the catalog works that way --
  // both remaining options have fixed hosts, and one of them sends no request at all. Leaving
  // the declaration behind would keep "read and change all your data on all websites" in the
  // install prompt for a capability nothing exercises. Same failure mode as an unclaimed host
  // permission: silent, and only visible when something is deleted.
  it('no optional host permissions are declared', () => {
    expect(manifest.optional_host_permissions ?? []).toEqual([]);
  });

  it('the identity permission is there (needed by launchWebAuthFlow)', () => {
    expect(manifest.permissions).toContain('identity');
  });

  it('the content script still injects only into discussion pages', () => {
    expect(manifest.content_scripts[0].matches).toEqual([
      'https://osu.ppy.sh/beatmapsets/*/discussion*',
    ]);
  });
});
