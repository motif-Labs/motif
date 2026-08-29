import type { Command } from 'commander';
import os from 'node:os';
import { createProvider, createServer, startMemoryScheduler, startServer } from '@motif/server';
import { MotifClient } from '../api-client.js';
import { loadConfig, saveConfig } from '../config.js';
import { watchAndSync } from '../daemon/syncer.js';

export function registerUp(program: Command): void {
  program
    .command('up')
    .description('Solo mode: run the server locally and sync this machine into it')
    .option('--port <port>', 'port to listen on', '4680')
    .option('--db <path>', 'SQLite database path (default: ~/.motif/motif.db)')
    .action(async (opts: { port: string; db?: string }) => {
      const { claudeDir } = program.opts<{ claudeDir?: string }>();
      const server = createServer({ dbPath: opts.db });
      startServer(server, { port: Number(opts.port), hostname: '127.0.0.1' });
      const serverUrl = `http://127.0.0.1:${opts.port}`;
      const provider = createProvider();
      if (provider) {
        startMemoryScheduler(server.db, provider, server.bus, { log: console.log });
        console.log(`Session memory enabled (provider: ${provider.name})`);
      }

      const cfg = loadConfig();
      const client = new MotifClient({ serverUrl, token: server.token });
      const name = cfg.name ?? os.userInfo().username;
      const { memberId } = await client.register({ name, email: cfg.email, machine: os.hostname() });
      saveConfig({ ...cfg, serverUrl, token: server.token, memberId, name });

      const syncClient = new MotifClient({ serverUrl, token: server.token, memberId });
      watchAndSync(syncClient, cfg, {
        claudeDir,
        onReport: (r) => {
          if (r.pushed) console.log(`synced: ${r.pushed} session(s)`);
        },
      });

      console.log(`Motif up at ${serverUrl} (member: ${name})`);
      console.log(`Team token (dashboard login): ${server.token}`);
      console.log('Sessions on this machine are syncing live. Ctrl+C to stop.');
      await new Promise(() => {}); // run until killed
    });
}
