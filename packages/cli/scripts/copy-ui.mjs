// Ships the built dashboard inside the published package (dist/ui).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', '..', '..', 'ui', 'dist');
const dest = path.join(here, '..', 'dist', 'ui');

if (!fs.existsSync(path.join(src, 'index.html'))) {
  console.error('ui/dist not found, run `npm run build -w @motif/ui` first');
  process.exit(1);
}
fs.cpSync(src, dest, { recursive: true });
console.log(`copied ui -> ${dest}`);

// The published tarball needs its own copies of the legal + intro files,
// which live at the repo root.
const repoRoot = path.join(here, '..', '..', '..');
for (const file of ['LICENSE', 'NOTICE', 'README.md']) {
  fs.copyFileSync(path.join(repoRoot, file), path.join(here, '..', file));
}
console.log('copied LICENSE, NOTICE, README.md -> package root');
