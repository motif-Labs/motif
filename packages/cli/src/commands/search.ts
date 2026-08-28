import type { Command } from 'commander';
import path from 'node:path';
import { scanLocal, shortId } from '../local.js';

export function registerSearch(program: Command): void {
  program
    .command('search <query>')
    .description('Search session text (local scan; server FTS once connected)')
    .option('--project <path>', 'only sessions for this project path')
    .option('--json', 'machine-readable output')
    .action((query: string, opts: { project?: string; json?: boolean }) => {
      const { claudeDir } = program.opts<{ claudeDir?: string }>();
      const scan = scanLocal(claudeDir);
      const q = query.toLowerCase();
      const hits: { sessionId: string; shortId: string; title?: string; project: string; snippet: string }[] = [];

      for (const s of scan.sessions) {
        if (opts.project && s.projectPath !== path.resolve(opts.project)) continue;
        for (const m of s.messages) {
          if (m.role !== 'user' && m.role !== 'assistant') continue;
          const text = m.text ?? '';
          const idx = text.toLowerCase().indexOf(q);
          if (idx === -1) continue;
          const start = Math.max(0, idx - 40);
          hits.push({
            sessionId: s.id,
            shortId: shortId(s),
            title: s.title,
            project: path.basename(s.projectPath || '?'),
            snippet: text.slice(start, idx + q.length + 60).replace(/\s+/g, ' '),
          });
          break; // one hit per session is enough for the list
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(hits, null, 2));
        return;
      }
      if (hits.length === 0) {
        console.log('No matches.');
        return;
      }
      for (const h of hits) {
        console.log(`${h.shortId}  ${h.project}  ${h.title ?? ''}`);
        console.log(`   …${h.snippet}…`);
      }
    });
}
