import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A game can be restarted without reloading the tab, which makes every acquisition in
 * main.ts a question of whether it is also released.
 *
 * Listeners on `window` are the sharp case. Everything the UI attaches to its own DOM
 * nodes dies when teardown calls `root.replaceChildren()`, and `input.ts` and
 * `minimap.ts` own explicit `dispose()`s — but a `window` listener outlives all of that
 * unless it was registered against the lifetime's AbortSignal. One that is not keeps a
 * closure over the previous game's host, selection and UI, and fires alongside the new
 * one: a restarted match had two keydown handlers, a twice-restarted match three.
 *
 * This reads the real file rather than a synthetic one, because the property worth
 * guarding is about this file specifically.
 */

const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

/** Modules that attach listeners and hand back a dispose() to take them off again. */
const DISPOSERS = ['../src/render/input.ts', '../src/ui/minimap.ts'] as const;

/** Event names passed to `target.addEventListener` / `removeEventListener` in a file. */
function listenerNames(text: string, method: 'add' | 'remove'): string[] {
  const pattern = new RegExp(`\\.${method}EventListener\\(\\s*'([^']+)'`, 'g');
  return [...text.matchAll(pattern)].map((match) => match[1]!).sort();
}

/** Every `target.addEventListener(...)` call in the source, as its full argument text. */
function listenerCalls(target: string): string[] {
  const needle = `${target}.addEventListener(`;
  const calls: string[] = [];

  for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + 1)) {
    let depth = 0;
    let end = at + needle.length - 1;
    for (; end < source.length; end++) {
      if (source[end] === '(') depth++;
      else if (source[end] === ')' && --depth === 0) break;
    }
    calls.push(source.slice(at, end + 1));
  }
  return calls;
}

describe('restart lifetime', () => {
  it('registers every window listener against the abort signal', () => {
    const calls = listenerCalls('window');
    // If this drops to zero the test has stopped testing anything.
    expect(calls.length).toBeGreaterThan(0);

    for (const call of calls) {
      const event = /addEventListener\(\s*'([^']+)'/.exec(call)?.[1] ?? '?';
      expect(call.includes('signal'), `window '${event}' listener outlives a restart`).toBe(true);
    }
  });

  it('releases the abort controller in teardown', () => {
    expect(source).toContain('lifetime.abort()');
  });

  // The other half of the same property. These modules do not get a signal; they hand
  // back a dispose(), and the two lists have to stay level. Adding a tenth listener and
  // forgetting its removal is the shape of leak this project has already shipped twice.
  it.each(DISPOSERS)('takes off every listener %s puts on', (module) => {
    const text = readFileSync(new URL(module, import.meta.url), 'utf8');
    const added = listenerNames(text, 'add');

    expect(added.length).toBeGreaterThan(0);
    expect(listenerNames(text, 'remove')).toEqual(added);
  });
});
