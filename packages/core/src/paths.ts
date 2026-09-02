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
