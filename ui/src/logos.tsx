/**
 * Simplified, recognizable agent marks (nominative use — every dashboard
 * identifies tools by their marks). Drawn inline so they inherit sizing and
 * never fetch anything.
 */

export function ClaudeMark({ size = 14 }: { size?: number }) {
  // Anthropic's tapered starburst, 8 rays
  const rays = Array.from({ length: 8 }, (_, i) => i * 45);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {rays.map((deg) => (
        <path
          d="M12 12 L10.4 3.2 Q12 1.6 13.6 3.2 Z"
          fill="currentColor"
          transform={`rotate(${deg} 12 12)`}
        />
      ))}
      <circle cx="12" cy="12" r="2.6" fill="currentColor" />
    </svg>
  );
}

export function CodexMark({ size = 14 }: { size?: number }) {
  // OpenAI's blossom knot, abstracted to six rotated lobes
  const lobes = Array.from({ length: 6 }, (_, i) => i * 60);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {lobes.map((deg) => (
        <rect
          x="10.6"
          y="2.6"
          width="2.8"
          height="11"
          rx="1.4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          transform={`rotate(${deg} 12 12)`}
          class="codex-lobe"
        />
      ))}
    </svg>
  );
}

export function CursorMark({ size = 14 }: { size?: number }) {
  // Cursor's isometric cube
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <polygon points="12,2 21,7 12,12 3,7" fill="currentColor" opacity="0.92" />
      <polygon points="3,7 12,12 12,22 3,17" fill="currentColor" opacity="0.55" />
      <polygon points="21,7 12,12 12,22 21,17" fill="currentColor" opacity="0.28" />
    </svg>
  );
}

export function AgentMark({ source, size = 14 }: { source: string; size?: number }) {
  if (source === 'claude-code') return <ClaudeMark size={size} />;
  if (source === 'codex') return <CodexMark size={size} />;
  if (source === 'cursor') return <CursorMark size={size} />;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="6" fill="currentColor" opacity="0.4" />
    </svg>
  );
}

export const AGENT_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
};
