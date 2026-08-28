import type { Command } from 'commander';
import { scanLocal } from '../local.js';

export function registerScan(program: Command): void {
  program
    .command('scan')
    .description('Scan local agent sessions and report what Motif can see')
    .option('--json', 'machine-readable output')
    .action((opts: { json?: boolean }) => {
      const { claudeDir } = program.opts<{ claudeDir?: string }>();
      const scan = scanLocal(claudeDir);
      const projects = new Set(scan.sessions.map((s) => s.projectPath));
      if (opts.json) {
        console.log(
          JSON.stringify(
            {
              sessions: scan.sessions.length,
              projects: projects.size,
              live: scan.sessions.filter((s) => scan.live.has(s.sourceSessionId)).length,
              failures: scan.failures,
            },
            null,
            2,
          ),
        );
        return;
      }
      console.log(`Sessions   ${scan.sessions.length}`);
      console.log(`Projects   ${projects.size}`);
      console.log(`Live now   ${scan.sessions.filter((s) => scan.live.has(s.sourceSessionId)).length}`);
      if (scan.failures.length > 0) {
        console.log(`Unreadable ${scan.failures.length}`);
        for (const f of scan.failures) console.log(`  ${f.path}: ${f.error}`);
      }
    });
}
