import type { Command } from 'commander';
import path from 'node:path';
import { scanLocal, shortId } from '../local.js';

export function registerList(program: Command): void {
  program
    .command('list')
    .description('List sessions, newest first')
    .option('--project <path>', 'only sessions for this project path')
    .option('--limit <n>', 'max rows', '20')
    .option('--json', 'machine-readable output')
    .action((opts: { project?: string; limit: string; json?: boolean }) => {
      const { claudeDir } = program.opts<{ claudeDir?: string }>();
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
