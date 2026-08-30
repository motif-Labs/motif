import type { Command } from 'commander';
import { MotifClient } from '../api-client.js';
import { loadConfig, requireConnection } from '../config.js';

export function registerComment(program: Command): void {
  program
    .command('comment <id> <text...>')
    .description('Pin a note onto a session (@Name mentions notify that teammate)')
    .action(async (id: string, textParts: string[]) => {
      const cfg = loadConfig();
      requireConnection(cfg);
      const client = new MotifClient({ serverUrl: cfg.serverUrl, token: cfg.memberToken });
      const sessionId = id.includes(':') ? id : `claude-code:${id}`;
      await client.addComment(sessionId, textParts.join(' '));
      console.log('Pinned.');
    });

  program
    .command('comments <id>')
    .description('Read the notes pinned onto a session')
    .action(async (id: string) => {
      const cfg = loadConfig();
      requireConnection(cfg);
      const client = new MotifClient({ serverUrl: cfg.serverUrl, token: cfg.memberToken });
      const sessionId = id.includes(':') ? id : `claude-code:${id}`;
      const comments = await client.listComments(sessionId);
      if (comments.length === 0) {
        console.log('No notes yet.');
        return;
      }
      for (const c of comments) {
        console.log(
          `@${c.author_name ?? '?'} · ${c.created_at.slice(0, 16).replace('T', ' ')}\n  ${c.body}\n`,
        );
      }
    });
}
