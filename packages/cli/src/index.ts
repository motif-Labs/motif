import { Command } from 'commander';
import { registerScan } from './commands/scan.js';
import { registerList } from './commands/list.js';
import { registerShow } from './commands/show.js';
import { registerSearch } from './commands/search.js';

const program = new Command();

program
  .name('motif')
  .description('Unification layer for AI coding agent sessions')
  .version('0.1.0')
  .option('--claude-dir <path>', 'Claude Code data directory (default: ~/.claude)');

registerScan(program);
registerList(program);
registerShow(program);
registerSearch(program);

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
