import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import { loadConfig } from '../config.js';

export function registerUi(program: Command): void {
  program
    .command('ui')
    .description('Open the Motif dashboard in your browser')
    .action(() => {
      const cfg = loadConfig();
      const url = cfg.serverUrl ?? 'http://127.0.0.1:4680';
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
      console.log(`Opening ${url}`);
      if (cfg.token) console.log(`Team token (paste it in the dashboard): ${cfg.token}`);
    });
}
