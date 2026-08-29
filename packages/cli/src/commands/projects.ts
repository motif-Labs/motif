import type { Command } from 'commander';
import path from 'node:path';
import { loadConfig, requireConnection, saveConfig } from '../config.js';
import { scanLocal } from '../local.js';
import { shouldSyncProject } from '../daemon/syncer.js';
import { isExcluded } from '../daemon/syncer.js';
import { MotifClient } from '../api-client.js';

/** Withdraw this member's already-synced sessions matching the glob from the server. */
async function purge(glob: string): Promise<void> {
  const cfg = loadConfig();
  requireConnection(cfg);
  const client = new MotifClient({ serverUrl: cfg.serverUrl, token: cfg.memberToken });
  const mine = await client.listSessions({ limit: 500 });
  const matching = mine.filter((s) => isExcluded(s.projectPath, [glob]));
  let deleted = 0;
  for (const s of matching) {
    try {
      await client.deleteSession(s.id);
      deleted++;
    } catch {
      // someone else's session with the same project — server refuses; skip
    }
  }
  console.log(`Purged ${deleted} session(s) matching ${glob} from the server.`);
}

export function registerProjects(program: Command): void {
  const projects = program
    .command('projects')
    .description('Control which projects sync to the team server');

  projects
    .command('list', { isDefault: true })
    .description('Show local projects and whether they sync')
    .action(() => {
      const { claudeDir } = program.opts<{ claudeDir?: string }>();
      const cfg = loadConfig();
      const mode = cfg.syncMode ?? 'all';
      console.log(`Mode: ${mode}${mode === 'selected' ? '  (only included projects sync)' : '  (everything syncs unless excluded)'}\n`);
      const seen = new Set<string>();
      for (const s of scanLocal(claudeDir).sessions) {
        if (!s.projectPath || seen.has(s.projectPath)) continue;
        seen.add(s.projectPath);
        const syncs = shouldSyncProject(s.projectPath, cfg);
        console.log(`${syncs ? '✓ syncs ' : '✗ local '} ${s.projectPath}`);
      }
      if (mode === 'selected') console.log(`\nIncluded: ${(cfg.include ?? []).join(', ') || '(none)'}`);
      if ((cfg.exclude ?? []).length) console.log(`Excluded: ${cfg.exclude!.join(', ')}`);
    });

  projects
    .command('mode <mode>')
    .description("'all' = everything syncs unless excluded; 'selected' = only included projects sync")
    .action((mode: string) => {
      if (mode !== 'all' && mode !== 'selected') throw new Error("mode must be 'all' or 'selected'");
      saveConfig({ ...loadConfig(), syncMode: mode });
      console.log(
        mode === 'selected'
          ? "Selected mode: nothing syncs until you run `motif projects include <path>` — personal work stays personal."
          : 'All mode: every project syncs unless excluded.',
      );
    });

  projects
    .command('include <pathOrGlob>')
    .description("Add a project to the allowlist (used in 'selected' mode)")
    .action((glob: string) => {
      const cfg = loadConfig();
      const value = glob.includes('*') ? glob : path.resolve(glob);
      saveConfig({ ...cfg, include: [...new Set([...(cfg.include ?? []), value])] });
      console.log(`Included: ${value}`);
      if ((cfg.syncMode ?? 'all') !== 'selected') {
        console.log("(note: the allowlist only takes effect in 'selected' mode — motif projects mode selected)");
      }
    });

  projects
    .command('exclude <pathOrGlob>')
    .description('Never sync matching projects; --purge also withdraws already-synced sessions')
    .option('--purge', 'delete your already-synced sessions of this project from the server')
    .action(async (glob: string, opts: { purge?: boolean }) => {
      const cfg = loadConfig();
      const value = glob.includes('*') ? glob : path.resolve(glob);
      saveConfig({
        ...cfg,
        exclude: [...new Set([...(cfg.exclude ?? []), value])],
        include: (cfg.include ?? []).filter((g) => g !== value),
      });
      console.log(`Excluded: ${value}`);
      if (opts.purge) await purge(value);
      else console.log('(already-synced sessions stay on the server — add --purge to withdraw them)');
    });

  projects
    .command('purge <pathOrGlob>')
    .description('Withdraw your already-synced sessions of matching projects from the server')
    .action(async (glob: string) => {
      await purge(glob.includes('*') ? glob : path.resolve(glob));
    });
}
