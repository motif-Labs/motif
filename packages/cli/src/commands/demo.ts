import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, startServer, whenListening } from '@motif/server';
import { seedDemo } from '../demo/seed.js';

/**
 * A populated team in one command, with nothing real involved: the seed is
 * written straight into a throwaway database, no reader runs, and your own
 * ~/.motif, ~/.claude, ~/.codex and Cursor storage are never opened.
 */
export function registerDemo(program: Command): void {
  program
    .command('demo')
    .description('Spin up an invented team so you can feel the product before pointing it at anything real')
    .option('--port <n>', 'port to listen on', '4699')
    .option('--no-open', 'do not open the dashboard in a browser')
    .option('--clean', 'remove the demo and exit')
    .action(async (opts: { port: string; open: boolean; clean?: boolean }) => {
      const dir = path.join(os.homedir(), '.motif-demo');
      if (opts.clean) {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log('Demo removed. Your own ~/.motif was never touched.');
        return;
      }

      // a fresh take every run — the demo is a showroom, not a workspace
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });

      const server = createServer({
        dbPath: path.join(dir, 'demo.db'),
        teamName: 'Demo Team',
      });
      const seeded = seedDemo(server.db);
      const port = Number(opts.port) || 4699;
      const listener = startServer(server, { port, hostname: '127.0.0.1' });
      await whenListening(listener);

      const ada = seeded.members.find((m) => m.name === 'ada')!;
      const base = `http://127.0.0.1:${port}`;
      const url = `${base}/?token=${encodeURIComponent(ada.token)}`;

      console.log(`
  Demo Team is up — ${seeded.sessions} invented sessions, 4 members, across two tools.
  Nothing here is yours: no reader ran, no real history was opened.

  Dashboard   ${base}   (signed in as ada)

  Things worth seeing:
    Review      ${seeded.reviewItems} conflict waits for a ruling — two sessions
                remember ADR-014 in opposite directions. Rule, and recall obeys.
    Memory      distilled decisions, one human-verified, one flagged stale
    Search      try: idempotency

  Drive it from a second terminal (server stays in this one):
    motif connect ${base} --token ${server.token} --name you
    motif memory review          # the conflict, both sides cited
    motif memory prefer <a> --over <b>   # rule — and recall obeys

  Or raw:
    curl -s '${base}/api/recall?q=why+do+we+fail+open+when+redis+is+down&format=markdown' \\
      -H 'authorization: Bearer ${ada.token}'

  Ctrl+C stops it · \`motif demo --clean\` removes every trace
`);

      if (opts.open) {
        if (process.platform === 'win32') {
          spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
        } else {
          const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
          spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
        }
      }
    });
}
