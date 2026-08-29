import type { Command } from 'commander';
import type { MotifSession } from '@motif/core';
import { resolveSession, scanLocal } from '../local.js';
import { loadConfig } from '../config.js';
import { MotifClient } from '../api-client.js';

const ROLE_LABEL: Record<string, string> = {
  user: 'user     ',
  assistant: 'assistant',
  reasoning: 'thinking ',
  tool_call: 'tool     ',
  tool_result: 'result   ',
};

export function registerShow(program: Command): void {
  program
    .command('show <id>')
    .description('Print a session transcript (id, uuid, or unique uuid prefix)')
    .option('--json', 'full MotifSession as JSON')
    .option('--tools', 'include tool calls and results (hidden by default)')
    .action(async (id: string, opts: { json?: boolean; tools?: boolean }) => {
      const { claudeDir } = program.opts<{ claudeDir?: string }>();
      const scan = scanLocal(claudeDir);
      let session: MotifSession;
      try {
        session = resolveSession(scan.sessions, id); // local parse is always freshest
      } catch (localErr) {
        const cfg = loadConfig();
        if (!cfg.serverUrl || !cfg.token) throw localErr;
        const client = new MotifClient({ serverUrl: cfg.serverUrl, token: cfg.memberToken ?? cfg.token });
        session = await client.getSession(id.includes(':') ? id : `claude-code:${id}`);
      }

      if (opts.json) {
        console.log(JSON.stringify(session, null, 2));
        return;
      }
      console.log(`# ${session.title ?? '(untitled)'}`);
      console.log(`${session.id}`);
      console.log(`project: ${session.projectPath}  branch: ${session.gitBranch ?? '-'}`);
      console.log(
        `${session.createdAt} → ${session.updatedAt}  messages: ${session.messages.length}` +
          (session.meta.subagentCount ? `  subagents: ${session.meta.subagentCount}` : '') +
          (session.meta.branchCount ? `  abandoned branches: ${session.meta.branchCount}` : ''),
      );
      if (session.filesTouched.length > 0) {
        console.log(`files: ${session.filesTouched.join(', ')}`);
      }
      console.log('');
      for (const m of session.messages) {
        if (!opts.tools && (m.role === 'tool_call' || m.role === 'tool_result')) continue;
        if (m.role === 'reasoning' && !opts.tools) continue;
        const label = ROLE_LABEL[m.role] ?? m.role;
        if (m.role === 'tool_call') {
          console.log(`[${label}] ${m.toolName}(${JSON.stringify(m.toolInput ?? {}).slice(0, 120)})`);
        } else {
          const text = (m.text ?? '').trim();
          if (!text) continue;
          console.log(`[${label}] ${text.length > 2000 ? text.slice(0, 2000) + ' …' : text}`);
        }
        console.log('');
      }
    });
}
