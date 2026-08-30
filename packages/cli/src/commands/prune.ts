import type { Command } from 'commander';
import { MotifClient } from '../api-client.js';
import { loadConfig, requireConnection } from '../config.js';

export function registerPrune(program: Command): void {
  program
    .command('prune')
    .description('Delete sessions older than N days from the team server (owner only; memory survives)')
    .requiredOption('--older-than <days>', 'age threshold in days (minimum 7)')
    .action(async (opts: { olderThan: string }) => {
      const cfg = loadConfig();
      requireConnection(cfg);
      const client = new MotifClient({ serverUrl: cfg.serverUrl, token: cfg.memberToken });
      const result = await client.prune(Number(opts.olderThan));
      console.log(
        `Pruned ${result.sessions} session(s) / ${result.messages} message(s) older than ${opts.olderThan} days.`,
      );
      console.log('Distilled memory notes were kept.');
    });
}
