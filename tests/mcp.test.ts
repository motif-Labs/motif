import { describe, expect, it } from 'vitest';
import { handleRpc, TOOLS } from '../packages/cli/src/mcp/server.js';
import type { Backend } from '../packages/cli/src/mcp/backend.js';

const calls: string[] = [];
const stub: Backend = {
  kind: 'local',
  async recall(q, project, budget) {
    calls.push(`recall:${q}:${project ?? '-'}:${budget ?? '-'}`);
    return '# Team context\n- we chose sqlite';
  },
  async search(q, limit) {
    calls.push(`search:${q}:${limit}`);
    return '# results';
  },
  async listSessions(project, limit) {
    calls.push(`list:${project ?? '-'}:${limit}`);
    return '# sessions';
  },
  async getSession(id, tail) {
    calls.push(`get:${id}:${tail}`);
    return '# transcript';
  },
  async ask(id, question, wait) {
    calls.push(`ask:${id}:${question}:${wait}`);
    return '# answer';
  },
};
const get = () => stub;

describe('mcp protocol', () => {
  it('handshakes and advertises its tools', async () => {
    const init = (await handleRpc(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      get,
    ))!;
    expect((init.result as { serverInfo: { name: string } }).serverInfo.name).toBe('motif');
    expect((init.result as { capabilities: { tools: unknown } }).capabilities.tools).toBeDefined();

    // notifications get no reply at all
    expect(await handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, get)).toBeNull();

    const list = (await handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, get))!;
    const names = (list.result as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual(['recall', 'search_sessions', 'list_sessions', 'get_session', 'ask_session']);
    for (const tool of TOOLS) {
      expect(tool.description.length).toBeGreaterThan(40); // the model reads these
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('routes tool calls with their defaults', async () => {
    const res = (await handleRpc(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'recall', arguments: { query: 'auth' } },
      },
      get,
    ))!;
    const content = (res.result as { content: { text: string }[]; isError: boolean }).content;
    expect(content[0]!.text).toContain('sqlite');
    expect((res.result as { isError: boolean }).isError).toBe(false);

    await handleRpc(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'get_session', arguments: { sessionId: 'x' } },
      },
      get,
    );
    await handleRpc(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'ask_session', arguments: { sessionId: 'x', question: 'why?' } },
      },
      get,
    );
    expect(calls).toContain('get:x:40');
    expect(calls).toContain('ask:x:why?:90');
  });

  it('reports tool failures to the model instead of breaking the protocol', async () => {
    const res = (await handleRpc(
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope', arguments: {} } },
      get,
    ))!;
    expect((res.result as { isError: boolean }).isError).toBe(true);
    expect((res.result as { content: { text: string }[] }).content[0]!.text).toContain('unknown tool');
  });

  it('answers unknown methods with a JSON-RPC error', async () => {
    const res = (await handleRpc({ jsonrpc: '2.0', id: 7, method: 'resources/subscribe' }, get))!;
    expect((res.error as { code: number }).code).toBe(-32601);
  });
});
