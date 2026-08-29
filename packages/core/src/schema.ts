/**
 * The tool-agnostic session contract. Every reader produces a MotifSession,
 * every writer and the server consume one. Source files on disk remain the
 * system of record; a MotifSession is a normalized projection of them.
 */

export type Source = 'claude-code' | 'codex' | 'cursor';

export type Role = 'user' | 'assistant' | 'reasoning' | 'tool_call' | 'tool_result';

export interface MotifMessage {
  /**
   * Stable id derived from the source. A multi-block assistant line explodes
   * into one message per content block, id'd `${sourceUuid}#${blockIndex}`.
   */
  id: string;
  role: Role;
  /** ISO 8601. Ordering must never rely on this (clock skew); it is display data. */
  timestamp: string;
  /** user/assistant/reasoning text; for tool_result, the model-visible output. */
  text?: string;
  toolName?: string;
  /** Joins tool_call <-> tool_result (e.g. Claude's `toolu_…` id). */
  toolCallId?: string;
  /** tool_call only: the original input object. */
  toolInput?: unknown;
}

export interface SessionMeta {
  subagentCount: number;
  /** Abandoned DAG branches (rewinds/edits) not on the active path. */
  branchCount: number;
  /** Unparseable or unknown lines skipped by the tolerant parser. */
  parseErrors: number;
  /** Model that produced the assistant turns, when the source records it. */
  model?: string;
  /** Size of the source transcript on disk, in bytes. */
  sourceBytes?: number;
}

export interface MotifSession {
  /** Globally unique: `${source}:${sourceSessionId}`. */
  id: string;
  source: Source;
  sourceSessionId: string;
  /** Absolute path of the source transcript on the originating machine. */
  sourcePath: string;
  /** The project working directory — taken from message payloads, not file paths. */
  projectPath: string;
  gitBranch?: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  /** Version of the source tool that wrote the session, when known. */
  toolVersion?: string;
  messages: MotifMessage[];
  /** Files changed via edit/write tools on the active path, deduped, in first-touch order. */
  filesTouched: string[];
  meta: SessionMeta;
}

export function motifSessionId(source: Source, sourceSessionId: string): string {
  return `${source}:${sourceSessionId}`;
}
