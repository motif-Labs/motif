import type { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MotifClient } from '../api-client.js';
import { loadConfig, motifHome, requireConnection } from '../config.js';
import { syncOnce, watchAndSync, type SyncReport } from '../daemon/syncer.js';

function reportLine(r: SyncReport): string {
  const parts = [`pushed ${r.pushed}`];
  if (r.appended) parts.push(`appended ${r.appended}`);
  if (r.replaced) parts.push(`replaced ${r.replaced}`);
  if (r.unchanged) parts.push(`unchanged ${r.unchanged}`);
  if (r.excluded) parts.push(`excluded ${r.excluded}`);
  if (r.errors.length) parts.push(`errors ${r.errors.length}`);
  return parts.join(', ');
}

function pidFile(): string {
  return path.join(motifHome(), 'daemon.pid');
}

function daemonPid(): number | undefined {
  try {
    const pid = Number(fs.readFileSync(pidFile(), 'utf8').trim());
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

export function registerSync(program: Command): void {
  program
    .command('sync')
    .description('Push local sessions to the team server')
    .option('--watch', 'keep running and sync as sessions change')
    .option('--force', 'resend everything, ignoring the sync watermark')
    .action(async (opts: { watch?: boolean; force?: boolean }) => {
      const { claudeDir } = program.opts<{ claudeDir?: string }>();
      const cfg = loadConfig();
      requireConnection(cfg);
      const client = new MotifClient({ serverUrl: cfg.serverUrl, token: cfg.memberToken });
      if (!opts.watch) {
        const report = await syncOnce(client, cfg, { claudeDir, force: opts.force });
        console.log(reportLine(report));
        for (const e of report.errors) console.error(`  ${e.sessionId}: ${e.error}`);
        return;
      }
      console.log(`Watching for session changes (server: ${cfg.serverUrl})…`);
      watchAndSync(client, cfg, {
        claudeDir,
        live: { serverUrl: cfg.serverUrl, token: cfg.memberToken, log: (m) => console.log(`[${new Date().toISOString()}] ${m}`) },
        onReport: (r) => {
          if (r.pushed || r.errors.length) console.log(`[${new Date().toISOString()}] ${reportLine(r)}`);
        },
      });
      await new Promise(() => {}); // run until killed
    });

  const daemon = program.command('daemon').description('Manage the background sync daemon');

  daemon
    .command('start')
    .description('Start the sync daemon in the background')
    .action(() => {
      const cfg = loadConfig();
      requireConnection(cfg);
      const existing = daemonPid();
      if (existing) {
        console.log(`Daemon already running (pid ${existing}).`);
        return;
      }
      fs.mkdirSync(motifHome(), { recursive: true });
      const logPath = path.join(motifHome(), 'daemon.log');
      try {
        // a 24/7 daemon must not grow its log forever; keep one rotated copy
        if (fs.statSync(logPath).size > 5 * 1024 * 1024) fs.renameSync(logPath, `${logPath}.old`);
      } catch {
        /* no log yet */
      }
      const log = fs.openSync(logPath, 'a');
      const child = spawn(process.execPath, [process.argv[1]!, 'sync', '--watch'], {
        detached: true,
        stdio: ['ignore', log, log],
      });
      child.unref();
      fs.writeFileSync(pidFile(), String(child.pid));
      console.log(`Daemon started (pid ${child.pid}). Logs: ${path.join(motifHome(), 'daemon.log')}`);
    });

  daemon
    .command('stop')
    .description('Stop the sync daemon')
    .action(() => {
      const pid = daemonPid();
      if (!pid) {
        console.log('Daemon is not running.');
        return;
      }
      process.kill(pid);
      fs.rmSync(pidFile(), { force: true });
      console.log(`Daemon stopped (pid ${pid}).`);
    });

  daemon
    .command('status')
    .description('Show whether the sync daemon is running')
    .action(() => {
      const pid = daemonPid();
      console.log(pid ? `Daemon running (pid ${pid}).` : 'Daemon is not running.');
    });
}
