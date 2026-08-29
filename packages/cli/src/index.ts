import { Command } from 'commander';
import { registerScan } from './commands/scan.js';
import { registerList } from './commands/list.js';
import { registerShow } from './commands/show.js';
import { registerSearch } from './commands/search.js';
import { registerConnect } from './commands/connect.js';
import { registerServer } from './commands/server.js';
import { registerSync } from './commands/sync.js';
import { registerUp } from './commands/up.js';
import { registerUi } from './commands/ui.js';
import { registerHandoff } from './commands/handoff.js';
import { registerProjects } from './commands/projects.js';
import { registerPrune } from './commands/prune.js';
import { registerOps } from './commands/ops.js';
import { registerComment } from './commands/comment.js';

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
registerConnect(program);
registerServer(program);
registerSync(program);
registerUp(program);
registerUi(program);
registerHandoff(program);
registerProjects(program);
registerPrune(program);
registerOps(program);
registerComment(program);

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
