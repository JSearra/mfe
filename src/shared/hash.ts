/**
 * FNV-1a, 32-bit. Used for state hashes (replay determinism) and tuning hashes.
 *
 * Chosen because it is trivial, allocation-free over a byte view, and its exact
 * output is fully specified — a cryptographic hash would be slower for no benefit,
 * since this guards against accidental divergence, not against an adversary.
 */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function hashBytes(bytes: Uint8Array, seed: number = FNV_OFFSET_BASIS): number {
  let h = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

/** Hash any typed array by its underlying bytes, without copying. */
export function hashTypedArray(array: ArrayBufferView, seed?: number): number {
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  return hashBytes(bytes, seed);
}

const encoder = new TextEncoder();

export function hashString(text: string, seed?: number): number {
  return hashBytes(encoder.encode(text), seed);
}

/** Render a hash as stable 8-digit hex, for committing into fixtures and logs. */
export function formatHash(hash: number): string {
  return (hash >>> 0).toString(16).padStart(8, '0');
}
