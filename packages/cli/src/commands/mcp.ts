import type { Command } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultCodexDir } from '@motif/core';
import { runMcpServer } from '../mcp/server.js';

/** How an agent should be told to launch us. */
function launchCommand(): { command: string; args: string[] } {
  // A bare `motif` is nicer in a config file, but only if it actually resolves:
  // under npx or a dev checkout it does not, and the agent would fail to spawn
  // us silently. Fall back to this exact interpreter and entry point.
  const onPath = spawnSync('motif', ['--version'], { stdio: 'ignore' }).status === 0;
  if (onPath) return { command: 'motif', args: ['mcp'] };
  return { command: process.execPath, args: [path.resolve(process.argv[1] ?? ''), 'mcp'] };
}

function installCursor(cmd: { command: string; args: string[] }, print: boolean): string {
  const file = path.join(os.homedir(), '.cursor', 'mcp.json');
  const snippet = { mcpServers: { motif: cmd } };
  if (print) return `${file}:\n${JSON.stringify(snippet, null, 2)}`;
  let existing: { mcpServers?: Record<string, unknown> } = {};
  if (fs.existsSync(file)) {
    // Back up before parsing: a config we cannot read is exactly the one we must
    // not replace. Parsing first meant that JSONC or a trailing comma produced
    // no backup and silently deleted every other MCP server the user had.
    fs.copyFileSync(file, `${file}.motif-backup`);
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf8')) as typeof existing;
    } catch {
      throw new Error(
        `${file} exists but is not valid JSON. A copy is at ${file}.motif-backup, ` +
          'fix or move it, then run this again.',
      );
    }
  }
  existing.mcpServers = { ...(existing.mcpServers ?? {}), motif: cmd };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(existing, null, 2)}\n`);
  return `✓ Cursor: ${file}`;
}

function installCodex(cmd: { command: string; args: string[] }, print: boolean): string {
  const file = path.join(defaultCodexDir(), 'config.toml');
  const block = `\n[mcp_servers.motif]\ncommand = ${JSON.stringify(cmd.command)}\nargs = ${JSON.stringify(cmd.args)}\n`;
  if (print) return `${file}:${block}`;
  let current = '';
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch {
    /* first time */
  }
  if (current.includes('[mcp_servers.motif]')) return '= Codex: already configured';
  if (current) fs.copyFileSync(file, `${file}.motif-backup`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, current + block);
  return `✓ Codex: ${file}`;
}

function installClaude(cmd: { command: string; args: string[] }, print: boolean): string {
  const shell = process.platform === 'win32';
  const cli = `claude mcp add motif --scope user -- ${cmd.command} ${cmd.args.join(' ')}`;
  if (print) return cli;
  const run = spawnSync(
    'claude',
    ['mcp', 'add', 'motif', '--scope', 'user', '--', cmd.command, ...cmd.args],
    {
      encoding: 'utf8',
      shell,
    },
  );
  if (run.error || run.status !== 0) {
    return `! Claude Code: run it yourself → ${cli}`;
  }
  return '✓ Claude Code: registered (claude mcp add motif)';
}

export function registerMcp(program: Command): void {
  const mcp = program
    .command('mcp')
    .description('Run the Motif MCP server (stdio) so agents can query the team memory')
    .action(() => {
      runMcpServer();
    });

  mcp
    .command('install')
    .description('Register the Motif MCP server with your agents (Claude Code, Codex, Cursor)')
    .argument('[agents...]', 'claude-code, codex, cursor (default: all)')
    .option('--print', 'only show the config, change nothing')
    .action((agents: string[], opts: { print?: boolean }) => {
      const cmd = launchCommand();
      const targets = agents.length > 0 ? agents : ['claude-code', 'codex', 'cursor'];
      console.log(opts.print ? 'Add this to each agent:\n' : 'Registering Motif as an MCP server…\n');
      for (const agent of targets) {
        if (agent === 'claude-code') console.log(installClaude(cmd, !!opts.print));
        else if (agent === 'codex') console.log(installCodex(cmd, !!opts.print));
        else if (agent === 'cursor') console.log(installCursor(cmd, !!opts.print));
        else console.log(`? unknown agent "${agent}"`);
      }
      if (!opts.print) {
        console.log('\nRestart your agent, then ask it: "what does my team already know about X?"');
        console.log('Tools: recall · search_sessions · list_sessions · get_session · ask_session');
      }
    });
}
