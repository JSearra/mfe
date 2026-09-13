import { describe, expect, it } from 'vitest';
import { gloss, t } from '../src/core/i18n/index.js';

describe('i18n', () => {
  it('resolves nested keys', () => {
    expect(t('app.title')).toBe('Mfecane RTS');
    expect(t('debug.heading')).toBe('Debug');
  });

  it('substitutes tokens', () => {
    expect(t('debug.zoom', { zoom: 1.5 })).toBe('Zoom 1.5x');
    expect(t('debug.camera', { x: 10, y: -4 })).toBe('Camera 10, -4');
  });

  it('accepts both strings and numbers as parameters', () => {
    expect(t('debug.fps', { fps: 60 })).toBe('60 fps');
    expect(t('debug.fps', { fps: '—' })).toBe('— fps');
  });

  it('leaves a token in place when no value is supplied', () => {
    expect(t('debug.camera', { x: 1 })).toBe('Camera 1, {y}');
  });

  it('ignores parameters a message does not use', () => {
    expect(t('app.title', { unused: 1 })).toBe('Mfecane RTS');
  });

  it('returns the key when a message is missing, rather than throwing mid-render', () => {
    // Unreachable through the type system for `en`; reachable for an incomplete locale.
    expect(t('not.a.real.key' as Parameters<typeof t>[0])).toBe('not.a.real.key');
  });

  it('glosses terms that must never be translated', () => {
    // The term stays isiZulu; only the explanation is English. See docs/CONTENT.md.
    expect(gloss('impi')).toBe('armed body of men');
    expect(gloss('isibaya')).toBe('cattle enclosure');
  });
});
