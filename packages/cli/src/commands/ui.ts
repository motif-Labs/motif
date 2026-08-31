import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import { loadConfig } from '../config.js';

export function registerUi(program: Command): void {
  program
    .command('ui')
    .description('Open the Motif dashboard in your browser')
    .action(() => {
      const cfg = loadConfig();
      const base = cfg.serverUrl ?? 'http://127.0.0.1:4680';
      // Hand the browser the member token so a local user is signed in without
      // copying anything. The page consumes it and strips it from the URL.
      const url = cfg.memberToken ? `${base}/?token=${encodeURIComponent(cfg.memberToken)}` : base;
      if (process.platform === 'win32') {
        // `start` is a cmd builtin, not an executable
        spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
      } else {
        const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
        spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
      }
      console.log(`Opening ${base}`);
      if (!cfg.memberToken && cfg.token) {
        console.log(
          `Paste this to sign in (read-only — run \`motif connect\` for full access): ${cfg.token}`,
        );
      }
    });
}
