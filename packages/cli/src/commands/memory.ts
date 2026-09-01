import type { Command } from 'commander';
import { MotifClient, type MemoryReviewNote } from '../api-client.js';
import { loadConfig, requireConnection } from '../config.js';

function client(): MotifClient {
  const cfg = loadConfig();
  requireConnection(cfg);
  return new MotifClient({ serverUrl: cfg.serverUrl, token: cfg.memberToken ?? cfg.token });
}

function renderNote(n: MemoryReviewNote, label?: string): string {
  const who = n.author_name ? `@${n.author_name}` : 'unknown';
  const src = n.session_id ? ` · \`${n.session_id}\`` : '';
  const marks = [
    n.verification !== 'unverified' ? n.verification : null,
    n.stale ? `stale: ${n.stale_reason ?? 'sources moved on'}` : null,
  ]
    .filter(Boolean)
    .join(', ');
  return [
    `  ${label ? `${label} ` : ''}#${n.id} [${n.kind}] ${n.entity} · ${n.aspect}${marks ? ` (${marks})` : ''}`,
    `     ${n.body}`,
    `     — ${who}, ${n.created_at.slice(0, 10)}${src}`,
  ].join('\n');
}

export function registerMemory(program: Command): void {
  const memory = program
    .command('memory')
    .description('The distilled team memory: review what the machine believes, and rule on it');

  memory
    .command('review')
    .description('Everything waiting for a human: conflicts, stale notes, disputes')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      const { items } = await client().listMemoryReview();
      if (opts.json) {
        console.log(JSON.stringify(items, null, 2));
        return;
      }
      if (items.length === 0) {
        console.log('Nothing waits for a ruling — the memory is at peace.');
        return;
      }
      console.log(`${items.length} item(s) need a human:\n`);
      for (const item of items) {
        if (item.type === 'conflict' && item.against) {
          console.log('CONFLICT — two sessions disagree, both are shown to agents until you rule:');
          console.log(renderNote(item.against, 'standing:'));
          console.log(renderNote(item.note, 'challenger:'));
          console.log(
            `     rule: motif memory prefer ${item.note.id} --over ${item.against.id}   (or swap the ids)\n`,
          );
        } else if (item.type === 'stale') {
          console.log('STALE — the files this note came from have moved on since:');
          console.log(renderNote(item.note));
          console.log(
            `     rule: motif memory confirm ${item.note.id}   ·   motif memory retire ${item.note.id}\n`,
          );
        } else {
          console.log('DISPUTED — someone flagged this, evidence pending:');
          console.log(renderNote(item.note));
          console.log(
            `     rule: motif memory confirm ${item.note.id}   ·   motif memory retire ${item.note.id}\n`,
          );
        }
      }
    });

  memory
    .command('confirm <noteId>')
    .description('Vouch for a note — verified notes outrank machine-only ones in recall')
    .option('--reason <text>', 'why (recorded with the ruling)')
    .action(async (noteId: string, opts: { reason?: string }) => {
      await client().postMemoryVerdict(Number(noteId), 'confirm', { reason: opts.reason });
      console.log(`Note #${noteId} is now human-verified.`);
    });

  memory
    .command('prefer <winnerId>')
    .description('Resolve a conflict: this note wins, the other is superseded (kept, never deleted)')
    .requiredOption('--over <loserId>', 'the note it wins over')
    .option('--reason <text>', 'why (recorded with the ruling)')
    .action(async (winnerId: string, opts: { over: string; reason?: string }) => {
      await client().postMemoryVerdict(Number(winnerId), 'prefer', {
        overNoteId: Number(opts.over),
        reason: opts.reason,
      });
      console.log(`Conflict resolved: #${winnerId} stands, #${opts.over} is superseded by it.`);
    });

  memory
    .command('retire <noteId>')
    .description('Take a note out of service — it stays in the record, agents stop seeing it')
    .option('--reason <text>', 'why (recorded with the ruling)')
    .action(async (noteId: string, opts: { reason?: string }) => {
      await client().postMemoryVerdict(Number(noteId), 'retire', { reason: opts.reason });
      console.log(`Note #${noteId} retired — out of recall, still in the record.`);
    });

  memory
    .command('dispute <noteId>')
    .description('Flag a note you believe is wrong, without ruling yet')
    .option('--reason <text>', 'why (recorded with the ruling)')
    .action(async (noteId: string, opts: { reason?: string }) => {
      await client().postMemoryVerdict(Number(noteId), 'dispute', { reason: opts.reason });
      console.log(`Note #${noteId} marked disputed — it joins the review queue.`);
    });
}
