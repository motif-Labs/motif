/**
 * Motif as an MCP server — the way agents actually reach the team's memory.
 *
 * Hand-rolled JSON-RPC over stdio (newline-delimited, per the MCP stdio
 * transport) so the package keeps its four runtime dependencies. Nothing but
 * protocol messages may ever touch stdout; diagnostics go to stderr.
 */

import readline from 'node:readline';
import { createBackend, type Backend } from './backend.js';
import { CLI_VERSION } from '../version.js';

const PROTOCOL_VERSION = '2025-06-18';

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export const TOOLS = [
  {
    name: 'recall',
    description:
      'Recall what this team already learned about a topic, from every past AI coding session (Claude Code, Codex, Cursor). Returns distilled decisions, human notes and cited transcript excerpts within a small token budget. USE THIS FIRST — before grepping files or asking the user to re-explain — whenever you touch unfamiliar code, wonder why something is the way it is, or start a task in a project you have not seen this session.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to know, in natural language.' },
        project: { type: 'string', description: 'Absolute project path to scope the answer to (optional).' },
        budget: { type: 'number', description: 'Approximate token ceiling for the reply (default 1500).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_sessions',
    description:
      "Full-text search across every teammate's agent sessions. Returns session ids with snippets — use recall for answers, this for finding the session itself.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number', description: 'Max results (default 10).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_sessions',
    description: 'List recent sessions across the team, newest first (optionally one project).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        limit: { type: 'number', description: 'Default 15.' },
      },
    },
  },
  {
    name: 'get_session',
    description:
      'Read a session transcript by id (from recall/search results). Prefer the tail — these can be very long.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        tail: { type: 'number', description: 'Only the last N messages (default 40; 0 = all).' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'ask_session',
    description:
      "Ask a past session a question and get an answer from the agent that lived it, with its full context — not a summary. The session is resumed read-only on the machine that owns it, so this can take a minute; teammates' sessions are answered by their machine. Use when recall's excerpts are not enough and you need the reasoning behind a decision.",
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        question: { type: 'string' },
        waitSeconds: { type: 'number', description: 'How long to wait for the answer (default 90).' },
      },
      required: ['sessionId', 'question'],
    },
  },
] as const;

async function callTool(backend: Backend, name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'recall':
      return backend.recall(
        String(args.query ?? ''),
        args.project ? String(args.project) : undefined,
        args.budget ? Number(args.budget) : undefined,
      );
    case 'search_sessions':
      return backend.search(String(args.query ?? ''), args.limit ? Number(args.limit) : 10);
    case 'list_sessions':
      return backend.listSessions(
        args.project ? String(args.project) : undefined,
        args.limit ? Number(args.limit) : 15,
      );
    case 'get_session':
      return backend.getSession(
        String(args.sessionId ?? ''),
        args.tail === undefined ? 40 : Number(args.tail),
      );
    case 'ask_session':
      return backend.ask(
        String(args.sessionId ?? ''),
        String(args.question ?? ''),
        args.waitSeconds ? Number(args.waitSeconds) : 90,
      );
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

/** Returns the response object, or null for notifications (which get no reply). */
export async function handleRpc(
  req: RpcRequest,
  getBackend: () => Backend,
): Promise<Record<string, unknown> | null> {
  const { id, method } = req;
  const isNotification = id === undefined || id === null;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: (req.params?.protocolVersion as string) ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'motif', version: CLI_VERSION },
        instructions:
          "Motif exposes this team's past AI coding sessions. Call recall before exploring unfamiliar code; cite session ids in your answer.",
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return isNotification ? null : ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'resources/list':
      return ok({ resources: [] });
    case 'prompts/list':
      return ok({ prompts: [] });
    case 'tools/call': {
      const name = String(req.params?.name ?? '');
      const args = (req.params?.arguments as Record<string, unknown>) ?? {};
      try {
        const text = await callTool(getBackend(), name, args);
        return ok({ content: [{ type: 'text', text }], isError: false });
      } catch (err) {
        // tool failures are results, not protocol errors — the model should see them
        return ok({
          content: [{ type: 'text', text: `Motif error: ${(err as Error).message}` }],
          isError: true,
        });
      }
    }
    default:
      return isNotification ? null : fail(-32601, `method not found: ${method}`);
  }
}

export function runMcpServer(): void {
  let backend: Backend | undefined;
  const getBackend = (): Backend => (backend ??= createBackend());

  const out = (msg: unknown): void => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };

  readline.createInterface({ input: process.stdin }).on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: RpcRequest;
    try {
      req = JSON.parse(trimmed) as RpcRequest;
    } catch {
      out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
      return;
    }
    void handleRpc(req, getBackend)
      .then((res) => {
        if (res) out(res);
      })
      .catch((err: Error) => {
        process.stderr.write(`motif mcp: ${err.message}\n`);
        if (req.id !== undefined && req.id !== null) {
          out({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: err.message } });
        }
      });
  });

  process.stderr.write(`motif mcp ${CLI_VERSION} ready (stdio)\n`);
}
