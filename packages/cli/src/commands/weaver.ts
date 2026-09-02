import type { Command } from 'commander';
import path from 'node:path';
import { MotifClient } from '../api-client.js';
import { loadConfig, requireConnection, saveConfig } from '../config.js';

/**
 * The Weaver: an agent grown from the team's memory. When a person rules on a
 * contradiction, the repository may still say what the losing claim said — the
 * Weaver aligns it, in a throwaway worktree, as a draft PR with the ruling
 * cited. It acts only in projects you name, only on this machine, and it can
 * never touch a default branch.
 */
export function registerWeaver(program: Command): void {
  const weaver = program
    .command('weaver')
    .description('The agent that keeps the repo true to the team’s rulings — opt-in, per project');

  weaver
    .command('enable <path>')
    .description('Let the Weaver act on this project from this machine (draft PRs only)')
    .action((p: string) => {
      const abs = path.resolve(p);
      const cfg = loadConfig();
      const list = new Set(cfg.weaverProjects ?? []);
      list.add(abs);
      saveConfig({ ...cfg, weaverProjects: [...list] });
      console.log(`The Weaver may now act on ${abs} from this machine.`);
      console.log('When a ruling lands, it weaves the change in a throwaway worktree and opens a DRAFT PR.');
    });

  weaver
    .command('disable <path>')
    .description('Withdraw the Weaver from a project')
    .action((p: string) => {
      const abs = path.resolve(p);
      const cfg = loadConfig();
      saveConfig({ ...cfg, weaverProjects: (cfg.weaverProjects ?? []).filter((x) => x !== abs) });
      console.log(`The Weaver no longer acts on ${abs}.`);
    });

  weaver
    .command('scan')
    .description('Find gaps the record can see but the repo has not closed — untested fixes')
    .option('--project <path>', 'limit to one project')
    .option('--json', 'machine-readable output')
    .action(async (opts: { project?: string; json?: boolean }) => {
      const cfg = loadConfig();
      requireConnection(cfg);
      const client = new MotifClient({ serverUrl: cfg.serverUrl, token: cfg.memberToken });
      const { gaps } = await client.listWeaverGaps(opts.project);
      if (opts.json) {
        console.log(JSON.stringify(gaps, null, 2));
        return;
      }
      if (gaps.length === 0) {
        console.log('No open gaps — every recorded fix has a test.');
        return;
      }
      console.log(`${gaps.length} untested fix(es) the Weaver could close:\n`);
      for (const g of gaps) {
        console.log(`  ${g.file}`);
        console.log(`    ${g.sessionTitle}${g.memberName ? ` — @${g.memberName}` : ''}`);
        console.log(`    close it:  motif weaver run ${g.file}\n`);
      }
    });

  weaver
    .command('run <file>')
    .description('Queue the Weaver to write the missing test for a file (draft PR)')
    .option('--project <path>', 'the project the file belongs to')
    .action(async (file: string, opts: { project?: string }) => {
      const cfg = loadConfig();
      requireConnection(cfg);
      const client = new MotifClient({ serverUrl: cfg.serverUrl, token: cfg.memberToken });
      const { job } = await client.queueWeaverGap(file, opts.project);
      console.log(`Queued #${job.id} for ${file}.`);
      console.log('An opted-in machine holding this project will write the test and open a draft PR.');
      console.log('Watch it with:  motif weaver status');
    });

  weaver
    .command('resolve <jobId> <fate>')
    .description('Record a Weaver PR’s fate (merged | closed) — a closed ruling-fix reopens the ruling')
    .action(async (jobId: string, fate: string) => {
      if (fate !== 'merged' && fate !== 'closed') {
        console.error('fate must be: merged | closed');
        process.exitCode = 1;
        return;
      }
      const cfg = loadConfig();
      requireConnection(cfg);
      const client = new MotifClient({ serverUrl: cfg.serverUrl, token: cfg.memberToken });
      const { reopenedNote } = await client.resolveWeaverJob(Number(jobId), fate);
      console.log(`Recorded: #${jobId} ${fate}.`);
      if (reopenedNote) {
        console.log('That fix came from a ruling, and it was closed — the ruling is back in review.');
      }
    });

  weaver
    .command('status')
    .description('What the Weaver has woven, and what still waits')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      const cfg = loadConfig();
      const enabled = cfg.weaverProjects ?? [];
      if (!opts.json) {
        console.log(
          enabled.length === 0
            ? 'The Weaver is idle on this machine — enable it per project: motif weaver enable <path>'
            : `Enabled here:\n${enabled.map((p) => `  ${p}`).join('\n')}`,
        );
      }
      requireConnection(cfg);
      const client = new MotifClient({ serverUrl: cfg.serverUrl, token: cfg.memberToken });
      const { jobs } = await client.listWeaverJobs();
      if (opts.json) {
        console.log(JSON.stringify({ enabled, jobs }, null, 2));
        return;
      }
      if (jobs.length === 0) {
        console.log('\nNo rulings have needed weaving yet.');
        return;
      }
      console.log('');
      for (const j of jobs.slice(0, 10)) {
        const mark =
          j.status === 'done' ? '✓' : j.status === 'error' ? '✗' : j.status === 'running' ? '…' : '·';
        console.log(
          `  ${mark} #${j.id} ${j.project_path}  ${j.status}${j.pr_url ? `  ${j.pr_url}` : ''}${
            j.result && !j.pr_url ? `  — ${j.result}` : ''
          }`,
        );
      }
    });
}
