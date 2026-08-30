import { describe, expect, it } from 'vitest';
import type { MotifSession } from '@motif/core';
import { effectiveRedactPatterns, isExcluded, redactSession } from '../packages/cli/src/daemon/syncer.js';

const session: MotifSession = {
  id: 'claude-code:r1',
  source: 'claude-code',
  sourceSessionId: 'r1',
  sourcePath: '/fake/r1.jsonl',
  projectPath: '/Users/me/secret-project',
  createdAt: '',
  updatedAt: '',
  messages: [
    { id: 'u1', role: 'user', timestamp: '', text: 'my key is sk-abcdefghijklmnopqrstuv123' },
    {
      id: 'a1#0',
      role: 'tool_call',
      timestamp: '',
      toolName: 'Bash',
      toolInput: { command: 'curl -H "Authorization: sk-abcdefghijklmnopqrstuv123" api.example.com' },
    },
  ],
  filesTouched: [],
  meta: { subagentCount: 0, branchCount: 0, parseErrors: 0 },
};

describe('privacy controls', () => {
  it('redacts message text AND tool inputs before anything leaves the machine', () => {
    const redacted = redactSession(session, ['sk-[A-Za-z0-9]{20,}']);
    expect(JSON.stringify(redacted)).not.toContain('sk-abcdefghijklmnopqrstuv123');
    expect(redacted.messages[0]!.text).toContain('[REDACTED]');
    expect(JSON.stringify(redacted.messages[1]!.toolInput)).toContain('[REDACTED]');
  });

  it('exclude globs keep whole projects local', () => {
    expect(isExcluded('/Users/me/secret-project', ['**/secret-project'])).toBe(true);
    expect(isExcluded('/Users/me/public-project', ['**/secret-project'])).toBe(false);
  });

  it('exclude globs match Windows-style paths too', () => {
    expect(isExcluded('C:\\Users\\me\\secret-project', ['**/secret-project'])).toBe(true);
  });

  it('built-in secret patterns are on by default and catch common token shapes', () => {
    const patterns = effectiveRedactPatterns({});
    const scrub = (text: string) =>
      redactSession({ ...session, messages: [{ id: 'x', role: 'user', timestamp: '', text }] }, patterns)
        .messages[0]!.text!;

    expect(scrub('key: AKIAIOSFODNN7EXAMPLE')).toContain('[REDACTED]');
    expect(scrub('token ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toContain('[REDACTED]');
    expect(scrub('slack xoxb-1234567890-abcdefghij')).toContain('[REDACTED]');
    expect(
      scrub('jwt eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM'),
    ).toContain('[REDACTED]');
    expect(scrub('-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----')).toContain(
      '[REDACTED]',
    );
    expect(scrub('motif token mm_EXAMPLEtokenNOTreal000000000000000')).toContain('[REDACTED]');
    // ordinary prose survives
    expect(scrub('we chose sqlite for storage')).toBe('we chose sqlite for storage');
  });

  it('defaults can be opted out per machine', () => {
    expect(effectiveRedactPatterns({ redactDefaults: false })).toEqual([]);
    expect(effectiveRedactPatterns({ redactDefaults: false, redactPatterns: ['foo'] })).toEqual(['foo']);
  });
});
