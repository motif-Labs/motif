import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { LiveBus, applyNotes, openDb, registerMember, startWebhooks, type Db } from '@motif/server';

let tmp: string;
let db: Db;
let received: Record<string, unknown>[];
let receiver: http.Server;
let url: string;

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'motif-webhook-'));
  db = openDb(path.join(tmp, 'db.sqlite'));
  received = [];
  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      received.push(JSON.parse(body) as Record<string, unknown>);
      res.end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  const addr = receiver.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  url = `http://127.0.0.1:${addr.port}/hook`;
});
afterEach(() => {
  receiver.close();
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const settle = () => new Promise((r) => setTimeout(r, 150));

describe('webhooks — one URL, told what matters', () => {
  it('pings on a fresh conflict, in words Slack renders as-is', async () => {
    const bus = new LiveBus();
    const hooks = startWebhooks(db, bus, url);
    bus.publish('memory-conflict', { entity: 'redis outage policy', aspect: 'limiter behaviour' });
    await settle();
    hooks.stop();

    expect(received).toHaveLength(1);
    expect(received[0]!.event).toBe('memory-conflict');
    expect(String(received[0]!.text)).toContain('redis outage policy');
    expect(String(received[0]!.text)).toContain('Review');
  });

  it('digests the open queue on the timer, and stays silent when it is empty', async () => {
    const bus = new LiveBus();
    // empty queue: the timer must not post
    const quiet = startWebhooks(db, bus, url, { digestMs: 60 });
    await new Promise((r) => setTimeout(r, 150));
    quiet.stop();
    expect(received).toHaveLength(0);

    // now stage an unresolved conflict and let the digest fire
    const { memberId } = registerMember(db, { name: 'ada' });
    applyNotes(db, [{ entity: { kind: 'decision', name: 'x' }, aspect: 'a', body: 'first claim' }], {
      projectPath: '/workspace/app',
      sessionPk: null,
      memberId,
    });
    applyNotes(
      db,
      [
        {
          entity: { kind: 'decision', name: 'x' },
          aspect: 'a',
          body: 'opposite claim',
          contradictsCurrent: true,
        },
      ],
      { projectPath: '/workspace/app', sessionPk: null, memberId },
    );
    const loud = startWebhooks(db, bus, url, { digestMs: 60 });
    await new Promise((r) => setTimeout(r, 150));
    loud.stop();

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0]!.event).toBe('review-digest');
    expect(String(received[0]!.text)).toContain('1 conflict');
  });
});
