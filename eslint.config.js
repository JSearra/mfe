import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * The determinism hazard list. See docs/adr/0002-float64-not-fixed-point.md.
 *
 * IEEE-754 + - * / and sqrt are correctly rounded and bit-identical across JS engines.
 * These are not: they are implementation-defined, not correctly rounded, or non-reproducible.
 * Every one has an owned replacement in src/sim/math/.
 */
const BANNED_MATH = [
  ['Math', 'random', 'Use createRng/nextFloat from src/sim/math/rng.ts.'],
  ['Math', 'sin', 'Use sin() from src/sim/math/trig.ts.'],
  ['Math', 'cos', 'Use cos() from src/sim/math/trig.ts.'],
  ['Math', 'tan', 'Implementation-defined. Derive from sin/cos in src/sim/math/trig.ts.'],
  ['Math', 'atan', 'Use atan2() from src/sim/math/trig.ts.'],
  ['Math', 'atan2', 'Use atan2() from src/sim/math/trig.ts.'],
  ['Math', 'asin', 'Implementation-defined. Avoid, or add an owned implementation.'],
  ['Math', 'acos', 'Implementation-defined. Avoid, or add an owned implementation.'],
  ['Math', 'exp', 'Implementation-defined. Avoid, or add an owned implementation.'],
  ['Math', 'log', 'Implementation-defined. Avoid, or add an owned implementation.'],
  ['Math', 'log2', 'Implementation-defined. Avoid, or add an owned implementation.'],
  ['Math', 'log10', 'Implementation-defined. Avoid, or add an owned implementation.'],
  ['Math', 'pow', 'Implementation-defined. Use explicit multiplication.'],
  ['Math', 'hypot', 'Not correctly rounded. Use Math.sqrt(dx*dx + dy*dy).'],
  ['Math', 'cbrt', 'Implementation-defined. Avoid.'],
  ['Math', 'sinh', 'Implementation-defined. Avoid.'],
  ['Math', 'cosh', 'Implementation-defined. Avoid.'],
  ['Math', 'tanh', 'Implementation-defined. Avoid.'],
  ['Date', 'now', 'The simulation has no wall clock. Use world.tick.'],
  ['performance', 'now', 'The simulation has no wall clock. Use world.tick.'],
];

const bannedProperties = BANNED_MATH.map(([object, property, message]) => ({
  object,
  property,
  message: `${object}.${property} breaks determinism. ${message}`,
}));

const DETERMINISM_SYNTAX = [
  {
    selector: "BinaryExpression[operator='**']",
    message: 'The ** operator is implementation-defined. Use explicit multiplication.',
  },
  {
    selector: "AssignmentExpression[operator='**=']",
    message: 'The **= operator is implementation-defined. Use explicit multiplication.',
  },
  {
    selector: "NewExpression[callee.name='Date']",
    message: 'The simulation has no wall clock. Use world.tick.',
  },
];

export default tseslint.config(
  {
    // tools/ is the Python art pipeline. Its virtualenv contains third-party JavaScript
    // (urllib3 ships an Emscripten worker), and ESLint's flat config does not read
    // .gitignore, so it has to be excluded here or `npm run lint` reports 174 errors
    // from somebody else's vendored code.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'tools/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // ---------------------------------------------------------------------------
  // Determinism: the simulation and anything it shares must be reproducible.
  // ---------------------------------------------------------------------------
  {
    files: ['src/sim/**/*.ts', 'src/shared/**/*.ts'],
    rules: {
      'no-restricted-properties': ['error', ...bannedProperties],
      'no-restricted-syntax': ['error', ...DETERMINISM_SYNTAX],
      'no-restricted-globals': [
        'error',
        { name: 'performance', message: 'The simulation has no wall clock. Use world.tick.' },
        { name: 'requestAnimationFrame', message: 'The simulation is tick-driven, not frame-driven.' },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Boundary: sim may not reach into rendering. See ADR-0004.
  // ---------------------------------------------------------------------------
  {
    files: ['src/sim/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['pixi.js', 'pixi.js/*'],
              message: 'src/sim must not import a renderer. See docs/adr/0004-defer-the-simulation-worker.md.',
            },
            {
              group: ['**/render/**', '**/render', '**/ui/**', '**/ui'],
              message: 'src/sim must not import render or ui code. The boundary is one-way.',
            },
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Hosts adapt the simulation to real time and to a transport. They sit outside
  // src/sim precisely so the determinism ban does not have to make an exception for
  // the worker's own clock — but the dependency still points one way.
  // ---------------------------------------------------------------------------
  {
    files: ['src/sim/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/host/**', '**/host'],
              allowTypeImports: true,
              message:
                'The simulation must not depend on its host. Hosts adapt the simulation, not the reverse.',
            },
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // Boundary: render and ui read snapshots and events, never the world.
  // Types may cross, values may not.
  // ---------------------------------------------------------------------------
  {
    files: ['src/render/**/*.ts', 'src/ui/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/sim/**', '**/sim'],
              allowTypeImports: true,
              message:
                'Render and UI read the snapshot and event list, never the world. Type-only imports are allowed.',
            },
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // i18n: no user-facing text baked into the UI layer.
  // Phase 1 will widen this once the UI approach is settled.
  // ---------------------------------------------------------------------------
  {
    files: ['src/ui/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "AssignmentExpression[left.property.name=/^(textContent|innerText|innerHTML|title|placeholder|alt|ariaLabel)$/][right.type='Literal']",
          message: 'User-facing text must come from t(). See CLAUDE.md.',
        },
        {
          selector: "JSXText[value=/\\S/]",
          message: 'User-facing text must come from t(). See CLAUDE.md.',
        },
        {
          selector:
            "CallExpression[callee.property.name='setAttribute'][arguments.0.value=/^(title|placeholder|alt|aria-label)$/][arguments.1.type='Literal']",
          message: 'User-facing text must come from t(). See CLAUDE.md.',
        },
      ],
    },
  },

  // Build and tooling scripts are plain JS, so no-undef applies where it does not for
  // TypeScript. They legitimately mix Node globals with browser ones, because the bodies
  // passed to page.evaluate() are serialised and run inside the browser.
  {
    files: ['scripts/**/*.mjs', 'scripts/**/*.js'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URL: 'readonly',
        document: 'readonly',
        performance: 'readonly',
        window: 'readonly',
      },
    },
  },

  // Tests compare owned implementations against the native ones they replace,
  // so the determinism bans do not apply here.
  {
    files: ['test/**/*.ts', '*.config.ts'],
    rules: {
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
      'no-restricted-globals': 'off',
      'no-restricted-imports': 'off',
    },
  },
);
