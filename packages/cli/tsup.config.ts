import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  // Workspace packages are private; inline them into the published bundle.
  noExternal: ['@motif/core', '@motif/server'],
});
