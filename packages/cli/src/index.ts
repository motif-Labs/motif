import { Command } from 'commander';
import { CLI_VERSION } from './version.js';
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
import { registerRecall } from './commands/recall.js';
import { registerAsk } from './commands/ask.js';
import { registerMcp } from './commands/mcp.js';
import { registerMemory } from './commands/memory.js';
import { registerDemo } from './commands/demo.js';
import { registerBlame } from './commands/blame.js';

const program = new Command();

program
  .name('motif')
  .description('Unification layer for AI coding agent sessions')
  .version(CLI_VERSION)
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
registerRecall(program);
registerAsk(program);
registerMcp(program);
registerMemory(program);
registerDemo(program);
registerBlame(program);

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
