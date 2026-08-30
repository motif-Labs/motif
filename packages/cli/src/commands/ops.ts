import type { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultClaudeDir, defaultCodexDir, discoverCodexSessions, discoverSessions } from '@motif/core';
import { discoverCursorConversations } from '../readers/cursor.js';
import { loadConfig, motifHome } from '../config.js';
import { MotifClient } from '../api-client.js';
import { CLI_VERSION } from '../version.js';

const pausedPath = () => path.join(motifHome(), 'paused');

function daemonPid(): number | undefined {
  try {
    const pid = Number(fs.readFileSync(path.join(motifHome(), 'daemon.pid'), 'utf8').trim());
    process.kill(pid, 0);
    return pid;
  } catch {
    return undefined;
  }
}

async function gatherStatus(claudeDir?: string) {
  const cfg = loadConfig();
  const pid = daemonPid();
  let stateAgeSec: number | undefined;
  try {
    stateAgeSec = Math.round(
      (Date.now() - fs.statSync(path.join(motifHome(), 'daemon-state.json')).mtimeMs) / 1000,
    );
  } catch {
    /* never synced */
  }
  let server: { reachable: boolean; team?: string; identity?: string } = { reachable: false };
  if (cfg.serverUrl) {
    try {
      const client = new MotifClient({ serverUrl: cfg.serverUrl, token: cfg.memberToken ?? cfg.token ?? '' });
      const me = await client.me();
      const team = (await fetch(new URL('/api/team', cfg.serverUrl), {
        headers: { authorization: `Bearer ${cfg.memberToken ?? cfg.token}` },
      }).then((r) => r.json())) as { name?: string };
      server = {
        reachable: true,
        team: team.name,
        identity: me.kind === 'member' ? `${me.member?.name} (member)` : 'team token (read-only)',
      };
    } catch {
      server = { reachable: false };
    }
  }
  return {
    version: CLI_VERSION,
    serverUrl: cfg.serverUrl ?? null,
    server,
    daemon: { running: pid !== undefined, pid: pid ?? null, paused: fs.existsSync(pausedPath()) },
    lastSyncAgeSeconds: stateAgeSec ?? null,
    syncMode: cfg.syncMode ?? 'all',
    sources: {
      'claude-code': discoverSessions(claudeDir).length,
      codex: discoverCodexSessions().length,
      cursor: discoverCursorConversations().length,
    },
  };
}

const SKILL_BODY = `---
name: motif
description: Query the team's past AI coding sessions (Claude Code, Codex, Cursor) before exploring unfamiliar code, and continue or hand off sessions across tools. Trigger when the user asks "did anyone work on X", "why is this like this", "what did <teammate> do", "continue this in Codex", or when you are about to grep around a codebase you have not seen this session.
---

# Motif — the team's session memory

Your team already solved things in earlier agent sessions. Check before rediscovering.

## If the Motif MCP server is connected (preferred)
Use its tools directly:
- \`recall\` — the distilled answer: past decisions, human notes, cited excerpts (~1.5k tokens). **Call this first.**
- \`search_sessions\` / \`list_sessions\` — find the session itself
- \`get_session\` — read a transcript (use \`tail\`, they are long)
- \`ask_session\` — ask a past session a question; the agent that lived it answers with full context

Not connected? Run \`motif mcp install\` once.

## Otherwise use the CLI
\`\`\`bash
motif recall "how does auth work here"     # same bundle, printed
motif search "rclone" --json               # find sessions
motif show <id> --json                     # read one
motif ask <id> "why did we drop rclone?"   # the session answers
motif handoff <id> --open                  # continue it in another agent
\`\`\`

## Rules
- Cite session ids (\`claude-code:…\`, \`codex:…\`) so humans can open them in the dashboard.
- Prefer recall over grep for "why" questions; prefer the codebase for "what does this code do".
- If recall returns nothing, say so and proceed normally — do not invent history.
`;

export function registerOps(program: Command): void {
  program
    .command('status')
    .description('Snapshot: server, identity, daemon, sync scope, detected sources')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      const { claudeDir } = program.opts<{ claudeDir?: string }>();
      const s = await gatherStatus(claudeDir);
      if (opts.json) {
        console.log(JSON.stringify(s, null, 2));
        return;
      }
      console.log(`motif ${s.version}`);
      console.log(
        `server     ${s.serverUrl ?? '(not connected)'}${s.server.reachable ? `  ✓ ${s.server.team ?? ''} — ${s.server.identity}` : s.serverUrl ? '  ✗ unreachable' : ''}`,
      );
      console.log(
        `daemon     ${s.daemon.running ? `running (pid ${s.daemon.pid})` : 'not running'}${s.daemon.paused ? '  ⏸ paused' : ''}`,
      );
      console.log(`last sync  ${s.lastSyncAgeSeconds === null ? 'never' : `${s.lastSyncAgeSeconds}s ago`}`);
      console.log(`scope      ${s.syncMode}`);
      console.log(
        `sources    claude-code: ${s.sources['claude-code']}  codex: ${s.sources.codex}  cursor: ${s.sources.cursor}`,
      );
    });

  program
    .command('doctor')
    .description('Diagnose the setup and suggest repairs')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      const { claudeDir } = program.opts<{ claudeDir?: string }>();
      const s = await gatherStatus(claudeDir);
      const checks: { name: string; ok: boolean; fix?: string }[] = [
        {
          name: 'connected to a server',
          ok: !!s.serverUrl,
          fix: 'motif connect <url> --token <team-token> --name <you>   (or solo: motif up)',
        },
        {
          name: 'server reachable',
          ok: !s.serverUrl || s.server.reachable,
          fix: 'is the server up? check the URL in ~/.motif/config.json',
        },
        {
          name: 'member identity (writes enabled)',
          ok: s.server.identity?.includes('member') ?? false,
          fix: 're-run motif connect to mint a member token',
        },
        {
          name: 'daemon running',
          ok: s.daemon.running,
          fix: 'motif daemon start   (auto-start: motif daemon install)',
        },
        { name: 'sync not paused', ok: !s.daemon.paused, fix: 'motif daemon resume' },
        {
          name: 'agent sessions detected',
          ok: Object.values(s.sources).some((n) => n > 0),
          fix: 'no Claude Code / Codex / Cursor sessions found on this machine yet',
        },
        {
          name: 'codex installed (handoff target)',
          ok: fs.existsSync(defaultCodexDir()),
          fix: 'npm i -g @openai/codex — handoff still works elsewhere without it',
        },
        {
          name: 'claude data dir present',
          ok: fs.existsSync(claudeDir ?? defaultClaudeDir()),
          fix: 'expected for Claude Code capture; fine if you only use other agents',
        },
      ];
      const ok = checks.every((c) => c.ok);
      if (opts.json) {
        console.log(JSON.stringify({ ok, checks, status: s }, null, 2));
        return;
      }
      for (const c of checks) {
        console.log(`${c.ok ? '✓' : '✗'} ${c.name}${c.ok || !c.fix ? '' : `\n    → ${c.fix}`}`);
      }
      console.log(ok ? '\nAll good.' : '\nFix the ✗ items above, then re-run motif doctor.');
      process.exitCode = ok ? 0 : 1;
    });

  program
    .command('update')
    .description('Check npm for a newer motif release')
    .action(async () => {
      try {
        const res = await fetch('https://registry.npmjs.org/getmotif/latest');
        if (!res.ok) throw new Error(String(res.status));
        const latest = ((await res.json()) as { version: string }).version;
        if (latest === CLI_VERSION) console.log(`motif ${CLI_VERSION} is up to date.`);
        else
          console.log(
            `motif ${latest} is available (you have ${CLI_VERSION}).\nUpdate with: npm i -g getmotif@latest`,
          );
      } catch {
        console.log(
          `Could not reach the npm registry (or motif isn't published yet). You have ${CLI_VERSION}.`,
        );
      }
    });

  program
    .command('skills')
    .description('Install a Motif skill into your agents so they can use the team memory')
    .argument('[agents...]', 'claude-code and/or codex (default: both)')
    .option('--force', 'overwrite an existing motif skill file')
    .action((agents: string[], opts: { force?: boolean }) => {
      const { claudeDir } = program.opts<{ claudeDir?: string }>();
      const targets = agents.length > 0 ? agents : ['claude-code', 'codex'];
      const dirs: Record<string, string> = {
        'claude-code': path.join(claudeDir ?? path.join(os.homedir(), '.claude'), 'skills', 'motif'),
        codex: path.join(defaultCodexDir(), 'skills', 'motif'),
      };
      for (const agent of targets) {
        const dir = dirs[agent];
        if (!dir) {
          console.log(`? unknown agent "${agent}" (supported: claude-code, codex)`);
          continue;
        }
        const file = path.join(dir, 'SKILL.md');
        if (fs.existsSync(file) && !opts.force) {
          console.log(`= ${agent}: skill already installed (${file})`);
          continue;
        }
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, SKILL_BODY);
        console.log(`+ ${agent}: installed ${file}`);
      }
      console.log('\nAgents can now answer "did anyone work on X?" from the team server.');
    });

  program
    .command('uninstall')
    .description('Stop Motif on this machine (native agent sessions are never touched)')
    .option('--purge', 'also delete ~/.motif (config, tokens, local sync state)')
    .action((opts: { purge?: boolean }) => {
      const pid = daemonPid();
      if (pid) {
        process.kill(pid);
        console.log(`Stopped daemon (pid ${pid}).`);
      }
      const launchAgent = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.motif.daemon.plist');
      if (fs.existsSync(launchAgent)) {
        fs.rmSync(launchAgent);
        console.log('Removed LaunchAgent (unloads at next logout, or: launchctl remove com.motif.daemon).');
      }
      // the systemd unit restarts the daemon on its own, so removing it is the
      // difference between uninstalling and briefly stopping
      const unit = path.join(os.homedir(), '.config', 'systemd', 'user', 'motif-daemon.service');
      if (fs.existsSync(unit)) {
        spawnSync('systemctl', ['--user', 'disable', '--now', 'motif-daemon'], { stdio: 'ignore' });
        fs.rmSync(unit);
        spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
        console.log(`Removed ${unit} and disabled the service.`);
      }
      if (opts.purge) {
        fs.rmSync(motifHome(), { recursive: true, force: true });
        console.log(`Deleted ${motifHome()}.`);
      } else {
        console.log(`Kept ${motifHome()} (config + tokens) — delete it yourself or re-run with --purge.`);
      }
      console.log('Your Claude Code / Codex / Cursor sessions were never moved and remain untouched.');
      console.log(
        'Server-side team data (if any) stays on the server. Uninstall the package with: npm rm -g getmotif',
      );
    });
}
