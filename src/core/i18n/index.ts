import en from './locales/en.json' with { type: 'json' };

/**
 * Translation lookup.
 *
 * Keys are derived from the English dictionary at compile time rather than generated
 * into a checked-in file. A codegen step would work, but it can go stale between the
 * dictionary and the generated union; a type cannot. The practical effect is that
 * t('does.not.exist') fails `npm run typecheck`, not at runtime in front of a player.
 *
 * Scope, deliberately: `en` only, no pluralisation, no locale negotiation. Those wait
 * until the UI copy stops churning. See docs/CONTENT.md section 6.
 */

type Dictionary = typeof en;

/** Dotted paths to string leaves. Intermediate objects are not valid keys. */
type LeafPaths<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${LeafPaths<T[K]>}`;
}[keyof T & string];

export type MessageKey = LeafPaths<Dictionary>;

export type MessageParams = Readonly<Record<string, string | number>>;

const TOKEN = /\{(\w+)\}/g;

let dictionary: Dictionary = en;

/** Replace the active dictionary. Present so tests can exercise fallbacks. */
export function setDictionary(next: Dictionary): void {
  dictionary = next;
}

function lookup(key: string): string | undefined {
  let node: unknown = dictionary;
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * Look up `key` and substitute any {token} placeholders.
 *
 * A missing key returns the key itself. That is the least-bad runtime behaviour: it
 * is obvious on screen, it cannot throw mid-render, and the type system has already
 * made it unreachable for the English dictionary.
 *
 * One hole in that last claim, found the hard way. `LeafPaths` cannot tell a nested
 * path from a flat key that happens to contain dots, so adding `"alert.stampede": "..."`
 * at the TOP level of the dictionary typechecks perfectly and then fails at runtime,
 * because lookup splits on the dot and goes looking for an `alert` object that is not
 * there. The symptom is the raw key rendered on screen. Nest new strings; do not write
 * their paths out flat.
 */
export function t(key: MessageKey, params?: MessageParams): string {
  const template = lookup(key);
  if (template === undefined) return key;
  if (params === undefined) return template;

  return template.replace(TOKEN, (match, token: string) => {
    const value = params[token];
    return value === undefined ? match : String(value);
  });
}

/**
 * Proper nouns and material-culture terms are not translated, only glossed.
 * See docs/CONTENT.md section 2 — `impi` stays `impi` in every locale.
 */
export function gloss(term: keyof Dictionary['glossary']): string {
  return dictionary.glossary[term];
}
