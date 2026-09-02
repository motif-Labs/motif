/**
 * One matcher for "does this stored path mean that asked path". Readers store
 * tool inputs verbatim — absolute, relative, and on Windows backslashed — while
 * callers ask with whatever their platform's path.relative() produced. The CLI
 * and the server must agree on the answer, so they both import this.
 */
export function filePathMatches(stored: string, asked: string): boolean {
  const s = stored.replace(/\\/g, '/');
  const a = asked.replace(/\\/g, '/');
  return s === a || s.endsWith(`/${a}`) || a.endsWith(`/${s}`);
}

/** The stricter tier: the stored path IS the asked file, not merely a
 * suffix-cousin from another tree. Same normalization as the matcher, so a
 * Windows-stored path can rank exact too. */
export function filePathExact(stored: string, asked: string): boolean {
  const s = stored.replace(/\\/g, '/');
  const a = asked.replace(/\\/g, '/');
  return s === a || s.endsWith(`/${a}`);
}
