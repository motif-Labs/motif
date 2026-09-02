import type { Command } from 'commander';
import path from 'node:path';
import { scanLocal, shortId } from '../local.js';
import { loadConfig } from '../config.js';
import { MotifClient } from '../api-client.js';

export function registerSearch(program: Command): void {
  program
    .command('search <query>')
    .description('Search session text (local scan; server FTS once connected)')
    .option('--project <path>', 'only sessions for this project path')
    .option('--json', 'machine-readable output')
    .action(async (query: string, opts: { project?: string; json?: boolean }) => {
      if (!query.trim()) {
        throw new Error('Nothing to search for. Try: motif search "idempotency"');
      }
      const { claudeDir } = program.opts<{ claudeDir?: string }>();
      const cfg = loadConfig();
      if (cfg.serverUrl && cfg.token) {
        try {
          const client = new MotifClient({ serverUrl: cfg.serverUrl, token: cfg.memberToken ?? cfg.token });
          const rows = await client.search(query, { project: opts.project });
          if (opts.json) {
            console.log(JSON.stringify(rows, null, 2));
            return;
          }
          if (rows.length === 0) {
            console.log('No matches.');
            return;
          }
          for (const h of rows) {
            console.log(`${h.id.split(':')[1]?.slice(0, 8)}  ${h.memberName ?? '?'}  ${h.title ?? ''}`);
            console.log(`   …${h.snippet}…`);
          }
          return;
        } catch {
          console.error('(server unreachable, falling back to local scan)');
        }
      }
      const scan = scanLocal(claudeDir);
      const q = query.toLowerCase();
      const hits: { sessionId: string; shortId: string; title?: string; project: string; snippet: string }[] =
        [];

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
