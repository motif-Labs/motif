import type { Command } from 'commander';
import path from 'node:path';
import { scanLocal, shortId } from '../local.js';
import { loadConfig } from '../config.js';
import { MotifClient } from '../api-client.js';

export function registerList(program: Command): void {
  program
    .command('list')
    .description('List sessions, newest first (team server when connected, else local)')
    .option('--project <path>', 'only sessions for this project path')
    .option('--limit <n>', 'max rows', '20')
    .option('--local', 'force local scan even when connected')
    .option('--json', 'machine-readable output')
    .action(async (opts: { project?: string; limit: string; local?: boolean; json?: boolean }) => {
      const { claudeDir } = program.opts<{ claudeDir?: string }>();
      const cfg = loadConfig();
      if (!opts.local && cfg.serverUrl && cfg.token) {
        try {
          const client = new MotifClient({ serverUrl: cfg.serverUrl, token: cfg.token, memberId: cfg.memberId });
          const rows = await client.listSessions({
            project: opts.project ? path.resolve(opts.project) : undefined,
            limit: Number(opts.limit) || 20,
          });
          if (opts.json) {
            console.log(JSON.stringify(rows, null, 2));
            return;
          }
          if (rows.length === 0) {
            console.log('No sessions on the server yet.');
            return;
          }
          for (const s of rows) {
            const when = s.updatedAt ? s.updatedAt.slice(0, 16).replace('T', ' ') : '                ';
            const proj = path.basename(s.projectPath || '?');
            const who = (s.memberName ?? '?').padEnd(10).slice(0, 10);
            console.log(
              `${s.id.split(':')[1]?.slice(0, 8)}  ${when}  ${who}  ${proj.padEnd(20).slice(0, 20)}  ${s.title ?? '(untitled)'}`,
            );
          }
          return;
        } catch {
          console.error('(server unreachable — falling back to local scan)');
        }
      }
      const scan = scanLocal(claudeDir);
      let sessions = scan.sessions;
      if (opts.project) {
        const target = path.resolve(opts.project);
        sessions = sessions.filter((s) => s.projectPath === target);
      }
      sessions = sessions.slice(0, Number(opts.limit) || 20);

      if (opts.json) {
        console.log(
          JSON.stringify(
            sessions.map((s) => ({
              id: s.id,
              shortId: shortId(s),
              title: s.title,
              projectPath: s.projectPath,
              gitBranch: s.gitBranch,
              updatedAt: s.updatedAt,
              messages: s.messages.length,
              live: scan.live.has(s.sourceSessionId),
            })),
            null,
            2,
          ),
        );
        return;
      }
      if (sessions.length === 0) {
        console.log('No sessions found.');
        return;
      }
      for (const s of sessions) {
        const live = scan.live.has(s.sourceSessionId) ? '●' : ' ';
        const when = s.updatedAt ? s.updatedAt.slice(0, 16).replace('T', ' ') : '                ';
        const proj = path.basename(s.projectPath || '?');
        console.log(
          `${live} ${shortId(s)}  ${when}  ${proj.padEnd(20).slice(0, 20)}  ${s.title ?? '(untitled)'}`,
        );
      }
    });
}
