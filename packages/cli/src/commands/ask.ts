import type { Command } from 'commander';
import { discoverCodexSessions, readCodexSession, type MotifSession } from '@motif/core';
import { MotifClient } from '../api-client.js';
import { loadConfig } from '../config.js';
import { resolveSession, scanLocal } from '../local.js';
import { askSessionLocally, canAnswerLocally, looksLive } from '../ask/perform.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function registerAsk(program: Command): void {
  program
    .command('ask <id> <question...>')
    .description('Ask a past session a question — the agent that lived it answers, with full context')
    .option('--wait <seconds>', "how long to wait for a teammate's machine", '120')
    .action(async (id: string, questionParts: string[], opts: { wait: string }) => {
      const question = questionParts.join(' ');
      const { claudeDir } = program.opts<{ claudeDir?: string }>();
      const cfg = loadConfig();
      const client =
        cfg.serverUrl && cfg.memberToken
          ? new MotifClient({ serverUrl: cfg.serverUrl, token: cfg.memberToken })
          : undefined;

      // 1. can this machine answer it? (our own session, transcript present)
      let local: MotifSession | undefined;
      try {
        local = resolveSession(scanLocal(claudeDir).sessions, id);
      } catch {
        const bare = id.includes(':') ? id.split(':')[1]! : id;
        const codexHit = discoverCodexSessions().filter((f) => f.sessionId.startsWith(bare));
        if (codexHit.length === 1) local = readCodexSession(codexHit[0]!.path);
      }
      if (local && canAnswerLocally(local)) {
        if (looksLive(local)) {
          console.error(`${local.id} is still running — resuming it could collide with the live process.`);
          process.exitCode = 1;
          return;
        }
        console.error(`Asking ${local.title ?? local.id} …`);
        const outcome = askSessionLocally(local, question);
        console.log(outcome.answer);
        // record it for the team so the answer is not lost in a terminal
        if (client) {
          const request = await client.createAsk(local.id, question).catch(() => undefined);
          if (request)
            await client
              .completeAskRequest(request.id, { status: 'done', answer: outcome.answer })
              .catch(() => {});
        }
        return;
      }

      // 2. otherwise the owner's machine answers it
      if (!client) {
        throw new Error(
          'That session is not on this machine and no server is configured (run `motif connect`).',
        );
      }
      const sessionId = id.includes(':')
        ? id
        : ((await client.exportSession(`claude-code:${id}`).catch(() => undefined))?.id ?? id);
      const request = await client.createAsk(sessionId, question);
      console.error(`Queued for the machine that owns "${request.session_title ?? sessionId}" — waiting…`);
      const deadline = Date.now() + (Number(opts.wait) || 120) * 1000;
      while (Date.now() < deadline) {
        await sleep(2500);
        const fresh = await client.getAsk(request.id).catch(() => undefined);
        if (fresh?.status === 'done') {
          console.log(fresh.answer);
          return;
        }
        if (fresh?.status === 'error') {
          console.error(`The session could not answer: ${fresh.error}`);
          process.exitCode = 1;
          return;
        }
      }
      console.error(
        `Still waiting — their daemon will answer when it is online. Check later: motif asks ${sessionId}`,
      );
    });

  program
    .command('asks <id>')
    .description('Questions asked of a session, and the answers')
    .action(async (id: string) => {
      const cfg = loadConfig();
      if (!cfg.serverUrl || !cfg.memberToken)
        throw new Error('Not connected (run `motif connect` or `motif up`).');
      const client = new MotifClient({ serverUrl: cfg.serverUrl, token: cfg.memberToken });
      const sessionId = id.includes(':') ? id : `claude-code:${id}`;
      const asks = await client.listAsksForSession(sessionId);
      if (asks.length === 0) {
        console.log('Nothing asked yet.');
        return;
      }
      for (const a of asks) {
        console.log(`@${a.asker_name ?? '?'} · ${a.created_at.slice(0, 16).replace('T', ' ')} · ${a.status}`);
        console.log(`  Q: ${a.question}`);
        if (a.answer) console.log(`  A: ${a.answer.replace(/\n/g, '\n     ')}`);
        if (a.error) console.log(`  ! ${a.error}`);
        console.log('');
      }
    });
}
