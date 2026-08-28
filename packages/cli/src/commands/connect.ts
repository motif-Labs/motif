import type { Command } from 'commander';
import os from 'node:os';
import { MotifClient } from '../api-client.js';
import { loadConfig, saveConfig } from '../config.js';

export function registerConnect(program: Command): void {
  program
    .command('connect <serverUrl>')
    .description('Connect this machine to a Motif team server')
    .requiredOption('--token <token>', 'team token (shown when the server starts)')
    .requiredOption('--name <name>', 'your name as teammates should see it')
    .option('--email <email>', 'your email (stable identity across machines)')
    .action(async (serverUrl: string, opts: { token: string; name: string; email?: string }) => {
      const client = new MotifClient({ serverUrl, token: opts.token });
      await client.health();
      const { memberId } = await client.register({
        name: opts.name,
        email: opts.email,
        machine: os.hostname(),
      });
      saveConfig({
        ...loadConfig(),
        serverUrl,
        token: opts.token,
        memberId,
        name: opts.name,
        email: opts.email,
      });
      console.log(`Connected to ${serverUrl} as ${opts.name} (member #${memberId}).`);
      console.log('Start syncing with: motif daemon start   (or one-shot: motif sync)');
    });
}
