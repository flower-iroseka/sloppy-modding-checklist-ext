import type { MessageKey, Msg } from '../../i18n';
import { DROPBOX_ORIGINS, DROPBOX_SPEC, dropboxApi } from './dropbox';
import type { AuthFlowDeps, OAuthSpec } from './oauth';
import { createOAuthProvider, type OAuthApi, type OAuthProviderDeps } from './oauthProvider';
import { createLocalFolderProvider, type LocalFolderDeps } from './localFolder';
import type { ProviderId, SyncProvider } from './types';

/**
 * The provider catalog. The settings page's options, the SW's registry and the manifest's
 * host permissions are all derived from this one file, so forgetting to update the manifest
 * when adding a provider is caught by a test (`tests/manifest.test.ts` compares `origins`
 * one by one). With the list in two places, a forgotten copy would only show up as
 * "silently can't fetch when connecting".
 */
export interface ProviderDescriptor {
  /** Which provider; also used to look up its implementation in `createProviders`. */
  id: ProviderId;
  /**
   * The dropdown entry. A key, not a string -- same reasoning as `SyncProvider.displayName`.
   */
  labelKey: MessageKey;
  /** Only OAuth providers have it. */
  oauth?: OAuthSpec;
  /**
   * Domains network requests will hit. localFolder has none -- it doesn't send a single
   * request (§7.7).
   */
  origins?: string[];
}

/**
 * The order = the order in the settings page dropdown, and the first item is the default a
 * new user sees.
 *
 * Local sync folder being first is deliberate: it's the only method that needs no developer
 * console and works right out of the box (§7.7). Dropbox still makes the user go register
 * an app in its console first, and for someone who just wants to "sync my checklist", that
 * bar is unreasonably high.
 *
 * OneDrive used to be here and was removed entirely by the user on 2026-09-11: since
 * 2024-06 personal Microsoft accounts can't register apps directly -- they need a directory
 * first (which usually means opening Azure and possibly entering a credit card), and this
 * extension's target users are all personal users, so that path is a dead end for everyone.
 * See §7.6 and appendix C for details.
 */
export const PROVIDER_CATALOG: ProviderDescriptor[] = [
  { id: 'localFolder', labelKey: 'provider.localFolder' },
  { id: 'dropbox', labelKey: 'provider.dropbox', oauth: DROPBOX_SPEC, origins: DROPBOX_ORIGINS },
];

/**
 * Look up the catalog entry by id.
 *
 * @param id which provider
 * @returns the catalog entry; undefined when the id isn't in the catalog
 */
export function catalogEntry(id: ProviderId): ProviderDescriptor | undefined {
  return PROVIDER_CATALOG.find((d) => d.id === id);
}

/**
 * A provider's name, wrapped into a `Msg` you can drop straight into `{provider}`.
 *
 * The OAuth provider's `spec.displayName` and the catalog's `labelKey` are the same key
 * (see how the `PROVIDER_CATALOG` rows are built), so taking it from the catalog is enough,
 * and call sites don't have to branch on "is this OAuth". When the id isn't in the catalog,
 * print the id as-is (`ProviderId` only has those three, so getting here means the caller
 * passed the wrong thing) -- an unfamiliar identifier in an error is easier to trace back
 * to the call site than a canned "unknown sync method".
 *
 * @param id which provider
 * @returns the name's template
 */
export function providerLabelMsg(id: ProviderId): Msg {
  const key = catalogEntry(id)?.labelKey;
  return key ? { key } : { key: 'err.raw', params: { detail: id } };
}

/**
 * The specs of the OAuth providers (the SW's auth flow and the settings page's wizard both
 * read it).
 */
export const OAUTH_SPECS: OAuthSpec[] = PROVIDER_CATALOG.flatMap((d) => (d.oauth ? [d.oauth] : []));

/**
 * Find the OAuth spec by id.
 *
 * @param id which provider
 * @returns that provider's spec; undefined when it's not an OAuth provider, or the id is unknown
 */
export function findSpec(id: ProviderId): OAuthSpec | undefined {
  return OAUTH_SPECS.find((s) => s.id === id);
}

/**
 * The union of all providers' host permissions (the source of truth for the README and
 * manifest).
 */
export function allOrigins(): string[] {
  return PROVIDER_CATALOG.flatMap((d) => d.origins ?? []);
}

// ---------------------------------------------------------------- Runtime

/** All the dependencies to inject when assembling providers. */
export interface ProviderDeps extends OAuthProviderDeps, AuthFlowDeps {
  /**
   * Local sync folder handle storage (§7.7). Only it needs this -- the other one doesn't
   * touch the filesystem.
   */
  folder: LocalFolderDeps;
}

/**
 * Each OAuth provider's file API implementation (only knows `{fetch, token}`, see
 * `oauthProvider.ts`).
 */
const OAUTH_APIS: Partial<Record<ProviderId, OAuthApi>> = {
  dropbox: dropboxApi,
};

/**
 * Assemble the table of usable providers.
 *
 * @param deps the dependencies for assembling
 * @returns each provider; unimplemented ones have no key
 */
export function createProviders(deps: ProviderDeps): Partial<Record<ProviderId, SyncProvider>> {
  const out: Partial<Record<ProviderId, SyncProvider>> = {
    localFolder: createLocalFolderProvider(deps.folder),
  };
  for (const desc of PROVIDER_CATALOG) {
    const api = OAUTH_APIS[desc.id];
    if (desc.oauth && api) out[desc.id] = createOAuthProvider(desc.oauth, api, deps);
  }
  return out;
}

/**
 * Get one provider from the table by id.
 *
 * @param providers the result of `createProviders`
 * @param id which provider; null means nothing picked yet
 * @returns the provider; null when nothing's picked or it isn't implemented
 */
export function getProvider(
  providers: Partial<Record<ProviderId, SyncProvider>>,
  id: ProviderId | null,
): SyncProvider | null {
  if (!id) return null;
  return providers[id] ?? null;
}

/**
 * The implemented provider ids, in the catalog's fixed order (display order must not drift
 * with object key order).
 *
 * @param providers the result of `createProviders`
 * @returns the implemented ids
 */
export function availableProviderIds(
  providers: Partial<Record<ProviderId, SyncProvider>>,
): ProviderId[] {
  return PROVIDER_CATALOG.filter((d) => providers[d.id] !== undefined).map((d) => d.id);
}
