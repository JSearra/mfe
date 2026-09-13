import { ESLint } from 'eslint';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The determinism and boundary guarantees in CLAUDE.md are only real if the lint rules
 * actually fire. These tests lint synthetic sources against the project's real config,
 * so a rule that gets weakened or dropped fails the build.
 *
 * lintText does not touch the filesystem; the path only selects which config applies.
 */
const eslint = new ESLint({ cwd: process.cwd() });

async function lint(relativePath: string, code: string) {
  const [result] = await eslint.lintText(code, { filePath: path.resolve(relativePath) });
  return result?.messages ?? [];
}

const rulesIn = (messages: { ruleId: string | null }[]) => messages.map((m) => m.ruleId);

describe('determinism rules in src/sim', () => {
  it('rejects Math.random', async () => {
    const messages = await lint('src/sim/probe.ts', 'export const x = Math.random();');
    expect(rulesIn(messages)).toContain('no-restricted-properties');
  });

  it.each(['sin', 'cos', 'atan2', 'pow', 'hypot', 'exp', 'log'])(
    'rejects Math.%s',
    async (fn) => {
      const messages = await lint('src/sim/probe.ts', `export const x = Math.${fn}(1, 2);`);
      expect(rulesIn(messages)).toContain('no-restricted-properties');
    },
  );

  it('rejects the ** operator', async () => {
    const messages = await lint('src/sim/probe.ts', 'export const x = 2 ** 8;');
    expect(rulesIn(messages)).toContain('no-restricted-syntax');
  });

  it('rejects wall-clock reads', async () => {
    expect(rulesIn(await lint('src/sim/probe.ts', 'export const t = Date.now();'))).toContain(
      'no-restricted-properties',
    );
    expect(rulesIn(await lint('src/sim/probe.ts', 'export const t = new Date();'))).toContain(
      'no-restricted-syntax',
    );
  });

  it('allows the operations that are exactly specified', async () => {
    const messages = await lint(
      'src/sim/probe.ts',
      'export const d = Math.sqrt(2 * 2 + 3 * 3) + Math.abs(-1) + Math.floor(0.5) + Math.imul(3, 4);',
    );
    expect(messages).toEqual([]);
  });

  it('applies the same bans to src/shared', async () => {
    const messages = await lint('src/shared/probe.ts', 'export const x = Math.random();');
    expect(rulesIn(messages)).toContain('no-restricted-properties');
  });

  it('does not restrict test code, which compares against the native functions', async () => {
    const messages = await lint('test/probe.ts', 'export const x = Math.sin(Math.random());');
    expect(messages).toEqual([]);
  });
});

describe('boundary rules', () => {
  it('stops src/sim importing a renderer', async () => {
    const messages = await lint('src/sim/probe.ts', "import 'pixi.js';\n");
    expect(rulesIn(messages)).toContain('no-restricted-imports');
  });

  it('stops src/sim importing render or ui code', async () => {
    expect(
      rulesIn(await lint('src/sim/probe.ts', "import { camera } from '../render/camera.js';\nconsole.log(camera);")),
    ).toContain('no-restricted-imports');
    expect(
      rulesIn(await lint('src/sim/probe.ts', "import { hud } from '../ui/hud.js';\nconsole.log(hud);")),
    ).toContain('no-restricted-imports');
  });

  it('stops render importing simulation values', async () => {
    const messages = await lint(
      'src/render/probe.ts',
      "import { spawn } from '../sim/world.js';\nconsole.log(spawn);",
    );
    expect(rulesIn(messages)).toContain('@typescript-eslint/no-restricted-imports');
  });

  it('allows render to import simulation types', async () => {
    const messages = await lint(
      'src/render/probe.ts',
      "import type { World } from '../sim/world.js';\nexport type W = World;",
    );
    expect(messages).toEqual([]);
  });
});

describe('i18n rule in src/ui', () => {
  it('rejects user-facing text assigned straight to the DOM', async () => {
    const messages = await lint(
      'src/ui/probe.ts',
      "declare const el: HTMLElement;\nel.textContent = 'Build kraal';",
    );
    expect(rulesIn(messages)).toContain('no-restricted-syntax');
  });

  it('exempts the empty string, which clears an element rather than saying anything', async () => {
    const messages = await lint(
      'src/ui/probe.ts',
      "declare const el: HTMLElement;\nel.textContent = '';",
    );
    // Flagging this pushes people toward workarounds instead of translations.
    expect(messages).toEqual([]);
  });

  it('accepts text that comes from t()', async () => {
    const messages = await lint(
      'src/ui/probe.ts',
      "declare const el: HTMLElement;\ndeclare function t(k: string): string;\nel.textContent = t('build.isibaya');",
    );
    expect(messages).toEqual([]);
  });
});
