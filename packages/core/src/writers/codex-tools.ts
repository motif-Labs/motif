/**
 * Claude Code → Codex tool-call translation. Handed-off history is context
 * for the model, never re-executed, so fidelity of meaning beats fidelity of
 * schema: each call is rendered as the Codex-native tool that would have done
 * the same job. Unknown tools pass through under their original name —
 * unknown function names in history are inert.
 */

export interface CodexCall {
  name: string;
  /** Codex/Responses API carries arguments as a JSON-encoded STRING. */
  arguments: string;
}

function shellCall(command: string): CodexCall {
  return { name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', command] }) };
}

function patchEnvelope(body: string): CodexCall {
  return { name: 'apply_patch', arguments: JSON.stringify({ input: body }) };
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function translateToolCall(toolName: string, input: unknown): CodexCall {
  const inp = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const str = (k: string): string | undefined =>
    typeof inp[k] === 'string' ? (inp[k] as string) : undefined;

  switch (toolName) {
    case 'Bash':
      return shellCall(str('command') ?? '');
    case 'Read': {
      const p = str('file_path') ?? '';
      return shellCall(`cat ${quote(p)}`);
    }
    case 'Glob': {
      const pattern = str('pattern') ?? '*';
      return shellCall(`find ${quote(str('path') ?? '.')} -name ${quote(pattern)}`);
    }
    case 'Grep': {
      const pattern = str('pattern') ?? '';
      return shellCall(`rg ${quote(pattern)} ${quote(str('path') ?? '.')}`);
    }
    case 'Edit': {
      const file = str('file_path') ?? 'unknown';
      const oldStr = str('old_string') ?? '';
      const newStr = str('new_string') ?? '';
      const body = [
        '*** Begin Patch',
        `*** Update File: ${file}`,
        '@@',
        ...oldStr.split('\n').map((l) => `-${l}`),
        ...newStr.split('\n').map((l) => `+${l}`),
        '*** End Patch',
      ].join('\n');
      return patchEnvelope(body);
    }
    case 'Write': {
      const file = str('file_path') ?? 'unknown';
      const content = str('content') ?? '';
      const body = [
        '*** Begin Patch',
        `*** Add File: ${file}`,
        ...content.split('\n').map((l) => `+${l}`),
        '*** End Patch',
      ].join('\n');
      return patchEnvelope(body);
    }
    default:
      return { name: toolName, arguments: JSON.stringify(input ?? {}) };
  }
}
