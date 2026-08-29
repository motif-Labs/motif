import { describe, expect, it } from 'vitest';
import type { MotifSession } from '@motif/core';
import { isExcluded, redactSession } from '../packages/cli/src/daemon/syncer.js';

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
});
