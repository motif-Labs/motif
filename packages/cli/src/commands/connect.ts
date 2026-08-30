import type { Command } from 'commander';
import os from 'node:os';
import { MotifClient } from '../api-client.js';
import { loadConfig, saveConfig } from '../config.js';
import { scanLocal } from '../local.js';
import { shouldSyncProject } from '../daemon/syncer.js';

export function registerConnect(program: Command): void {
  program
    .command('connect <serverUrl>')
    .description('Connect this machine to a Motif team server')
    .requiredOption('--token <token>', 'team token (shown when the server starts)')
    .requiredOption('--name <name>', 'your name as teammates should see it')
    .option('--email <email>', 'your email (stable identity across machines)')
    .option('--selected', 'start in allowlist mode: NOTHING syncs until you `motif projects include <path>`')
    .action(
      async (
        serverUrl: string,
        opts: { token: string; name: string; email?: string; selected?: boolean },
      ) => {
        if (!/^https?:\/\//.test(serverUrl)) {
          throw new Error(`Server URL needs a scheme — try http://${serverUrl}`);
        }
        const client = new MotifClient({ serverUrl, token: opts.token });
        try {
          await client.health();
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Could not reach a Motif server at ${serverUrl} (${why}).\n` +
              'Check the URL and that the server is running (`motif server` on that machine).',
          );
        }
        const { memberId, memberToken, role } = await client.register({
          name: opts.name,
          email: opts.email,
          machine: os.hostname(),
        });
        const cfg = {
          ...loadConfig(),
          serverUrl,
          token: opts.token,
          memberToken,
          memberId,
          name: opts.name,
          email: opts.email,
          ...(opts.selected ? { syncMode: 'selected' as const } : {}),
          // joining a team never auto-shares history: nothing is team-visible
          // until this machine marks projects with `motif projects team <path>`
          teamProjects: loadConfig().teamProjects ?? [],
        };
        saveConfig(cfg);
        console.log(`Connected to ${serverUrl} as ${opts.name} (member #${memberId}, ${role}).`);
        if (!opts.email) {
          console.log('(tip: pass --email next time — it keeps your identity stable across machines)');
        }
        console.log(
          'Your personal member token is in ~/.motif/config.json — use it to log in to the dashboard.\n',
        );

        // show exactly what would leave this machine before any sync happens
        const { claudeDir } = program.opts<{ claudeDir?: string }>();
        const projects = [
          ...new Set(
            scanLocal(claudeDir)
              .sessions.map((s) => s.projectPath)
              .filter(Boolean),
          ),
        ];
        if (projects.length > 0) {
          console.log('Projects on this machine and whether they will sync:');
          for (const p of projects)
            console.log(`  ${shouldSyncProject(p, cfg) ? '✓ syncs' : '✗ local'}  ${p}`);
          console.log(
            cfg.syncMode === 'selected'
              ? '\nAllowlist mode: add company projects with `motif projects include <path>`.'
              : '\nDoing personal work on this machine too? `motif projects mode selected` syncs only what you include.',
          );
        }
        console.log('\nStart syncing with: motif daemon start   (or one-shot: motif sync)');
      },
    );
}
