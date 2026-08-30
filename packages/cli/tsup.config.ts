import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  // Workspace packages are private; inline them into the published bundle.
  noExternal: ['@motif/core', '@motif/server'],
  // One source of truth for the version: the manifest.
  define: { __CLI_VERSION__: JSON.stringify(pkg.version) },
});
