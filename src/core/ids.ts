/**
 * Generate an id. Prefers crypto.randomUUID(); extension pages and content scripts are
 * both secure contexts, so this branch is normally the one that runs.
 *
 * @returns a random id in uuid v4 form
 */
export function newId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;

  // Fallback, rare: old environments that aren't a secure context
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Device id: generated once when the document is first created, then stored with the
 * document from then on.
 *
 * @returns an id with a `d-` prefix, to tell it apart from entry ids
 */
export function newDeviceId(): string {
  return `d-${newId()}`;
}
