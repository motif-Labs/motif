import type { Command } from 'commander';
import os from 'node:os';
import {
  createProvider,
  createServer,
  startMemoryScheduler,
  startServer,
  whenListening,
} from '@motif/server';
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
      // resolve the memory provider BEFORE binding the port: a missing
      // MOTIF_LLM_* value throws, and aborting mid-startup would leave a
      // listening server with no config written and nothing syncing
      const provider = createProvider();
      const server = createServer({ dbPath: opts.db });
      const listener = startServer(server, { port: Number(opts.port), hostname: '127.0.0.1' });
      await whenListening(listener);
      const serverUrl = `http://127.0.0.1:${opts.port}`;
      if (provider) {
        startMemoryScheduler(server.db, provider, server.bus, { log: console.log });
        console.log(`Session memory enabled (provider: ${provider.name})`);
      }

      const cfg = loadConfig();
      const name = cfg.name ?? os.userInfo().username;
      // reuse the stored identity when it still works; register mints one otherwise
      let memberId = cfg.memberId;
      let memberToken = cfg.memberToken;
      const stillValid =
        memberToken && cfg.serverUrl === serverUrl
          ? await new MotifClient({ serverUrl, token: memberToken })
              .me()
              .then((m) => m.kind === 'member')
              .catch(() => false)
          : false;
      if (!stillValid) {
        const reg = await new MotifClient({ serverUrl, token: server.token }).register({
          name,
          email: cfg.email,
          machine: os.hostname(),
        });
        memberId = reg.memberId;
        memberToken = reg.memberToken;
      }
      const saved = { ...cfg, serverUrl, token: server.token, memberToken, memberId, name };
      saveConfig(saved);

      const syncClient = new MotifClient({ serverUrl, token: memberToken! });
      // pass the saved config, not the one read before registering: the daemon
      // gates mention and ask notifications on memberId, minted just above
      watchAndSync(syncClient, saved, {
        claudeDir,
        live: { serverUrl, token: memberToken!, log: (m) => console.log(m) },
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
