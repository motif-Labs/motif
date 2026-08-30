import type { Command } from 'commander';
import path from 'node:path';
import { createBackend } from '../mcp/backend.js';
import { loadConfig } from '../config.js';
import { MotifClient } from '../api-client.js';

export function registerRecall(program: Command): void {
  program
    .command('recall <query...>')
    .description("What does the team already know about this? (the same bundle agents get over MCP)")
    .option('--project <path>', 'scope to one project')
    .option('--budget <tokens>', 'approximate token ceiling', '1500')
    .option('--json', 'machine-readable output (used by the benchmark)')
    .action(async (queryParts: string[], opts: { project?: string; budget: string; json?: boolean }) => {
      const query = queryParts.join(' ');
      const project = opts.project ? path.resolve(opts.project) : undefined;
      const budget = Number(opts.budget) || 1500;

      if (opts.json) {
        const cfg = loadConfig();
        if (cfg.serverUrl && cfg.memberToken) {
          const client = new MotifClient({ serverUrl: cfg.serverUrl, token: cfg.memberToken });
          console.log(JSON.stringify(await client.recall(query, { project, budget }), null, 2));
          return;
        }
        // no remote server: answer from the local database rather than falling
        // through to markdown, which would break anything piping this to jq
        const backend = createBackend();
        console.log(JSON.stringify(await backend.recallJson(query, project, budget), null, 2));
        return;
      }
      const backend = createBackend();
      console.log(await backend.recall(query, project, budget));
    });
}
