import type { Command } from 'commander';
import { createProvider, createServer, startMemoryScheduler, startServer } from '@motif/server';

export function registerServer(program: Command): void {
  program
    .command('server')
    .description('Run the self-hosted Motif team server')
    .option('--port <port>', 'port to listen on', process.env.MOTIF_PORT ?? '4680')
    .option('--host <host>', 'bind address (0.0.0.0 to accept teammates)', '0.0.0.0')
    .option('--db <path>', 'SQLite database path (default: ~/.motif/motif.db)')
    .action((opts: { port: string; host: string; db?: string }) => {
      const server = createServer({ dbPath: opts.db });
      startServer(server, { port: Number(opts.port), hostname: opts.host });
      const provider = createProvider();
      if (provider) {
        startMemoryScheduler(server.db, provider, server.bus, { log: console.log });
        console.log(`Session memory enabled (provider: ${provider.name})`);
      }
      console.log(`Motif server listening on http://${opts.host}:${opts.port}`);
      console.log(`Team token: ${server.token}`);
      console.log('Teammates connect with:');
      console.log(`  motif connect http://<this-host>:${opts.port} --token ${server.token} --name <name>`);
    });
}
