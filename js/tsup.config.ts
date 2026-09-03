import { defineConfig } from 'tsup';

/**
 * Two builds. The library ships ESM and CJS; the bin is ESM only (Node >= 20
 * runs it directly) and carries the shebang, which is why it is a separate
 * config: `banner` applies to every entry of one config, and a shebang
 * inside the library file would be wrong.
 *
 * Declarations are NOT tsup's job here: its `dts` step crashes under
 * TypeScript 7 (`useCaseSensitiveFileNames` of undefined, seen 2026-09-03).
 * `npm run types` emits them with tsc itself (tsconfig.build.json) and
 * copies index.d.ts to index.d.cts, which is valid because index.ts imports
 * nothing.
 */
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    target: 'node20',
    platform: 'node',
    sourcemap: true,
    clean: true,
    splitting: false,
  },
  {
    entry: { bin: 'src/bin.ts' },
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    sourcemap: true,
    splitting: false,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
