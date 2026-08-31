import type { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
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
        live: {
          serverUrl: cfg.serverUrl,
          token: cfg.memberToken,
          log: (m) => console.log(`[${new Date().toISOString()}] ${m}`),
        },
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
      const { claudeDir } = program.opts<{ claudeDir?: string }>();
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
      // The global --claude-dir has to travel with the child, or a daemon started
      // from a pinned shell silently reads the real ~/.claude instead. It is a
      // global option, so it goes before the subcommand.
      const childArgs = [
        process.argv[1]!,
        ...(claudeDir ? ['--claude-dir', claudeDir] : []),
        'sync',
        '--watch',
      ];
      const child = spawn(process.execPath, childArgs, {
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
      const paused = fs.existsSync(path.join(motifHome(), 'paused'));
      console.log(
        pid ? `Daemon running (pid ${pid})${paused ? ' — paused' : ''}.` : 'Daemon is not running.',
      );
    });

  daemon
    .command('pause')
    .description('Keep the daemon alive but stop shipping sessions')
    .action(() => {
      fs.mkdirSync(motifHome(), { recursive: true });
      fs.writeFileSync(path.join(motifHome(), 'paused'), new Date().toISOString());
      console.log('Paused — nothing leaves this machine until `motif daemon resume`.');
    });

  daemon
    .command('resume')
    .description('Resume shipping sessions')
    .action(() => {
      fs.rmSync(path.join(motifHome(), 'paused'), { force: true });
      console.log('Resumed — the next sweep syncs any backlog.');
    });

  daemon
    .command('install')
    .description('Start the daemon automatically at login (macOS LaunchAgent / Linux systemd user unit)')
    .action(() => {
      const entry = path.resolve(process.argv[1]!);
      if (process.platform === 'darwin') {
        const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.motif.daemon.plist');
        fs.mkdirSync(path.dirname(plist), { recursive: true });
        fs.writeFileSync(
          plist,
          `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.motif.daemon</string>
  <key>ProgramArguments</key><array>
    <string>${process.execPath}</string><string>${entry}</string><string>sync</string><string>--watch</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(motifHome(), 'daemon.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(motifHome(), 'daemon.log')}</string>
</dict></plist>
`,
        );
        spawn('launchctl', ['load', '-w', plist], { stdio: 'ignore' }).on('close', () => {});
        console.log(`Installed and loaded LaunchAgent: ${plist}`);
        console.log('The daemon now starts at every login. Remove with: motif uninstall');
      } else if (process.platform === 'linux') {
        const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
        fs.mkdirSync(unitDir, { recursive: true });
        const unit = path.join(unitDir, 'motif-daemon.service');
        fs.writeFileSync(
          unit,
          `[Unit]\nDescription=Motif session sync daemon\nAfter=network-online.target\n\n[Service]\nExecStart=${process.execPath} ${entry} sync --watch\nRestart=always\nRestartSec=10\n\n[Install]\nWantedBy=default.target\n`,
        );
        console.log(`Wrote ${unit}`);
        console.log(
          'Enable with: systemctl --user daemon-reload && systemctl --user enable --now motif-daemon',
        );
      } else {
        console.log('Auto-start install is not automated on this OS yet.');
        console.log(`Run at login: ${process.execPath} ${entry} sync --watch`);
      }
    });
}
