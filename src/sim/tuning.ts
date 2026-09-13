import tuningData from '../../tuning/tuning.json' with { type: 'json' };
import { hashString } from '../shared/hash.js';

/**
 * All magic numbers live in tuning/tuning.json, never inline in systems.
 *
 * The hash below is folded into every replay, so a replay recorded against different
 * tuning reports *that* as the reason it no longer matches, instead of failing as an
 * unexplained hash difference. See docs/ARCHITECTURE.md section 1.
 */
export const tuning = tuningData;

export type Tuning = typeof tuningData;

/** Stable serialization: object key order must not affect the hash. */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

export function tuningHash(source: unknown = tuning): number {
  return hashString(canonicalize(source));
}
