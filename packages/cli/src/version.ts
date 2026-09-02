/**
 * Injected by tsup at build time from packages/cli/package.json, so the binary
 * can never disagree with the manifest about its own version, it did once,
 * and a published release reported the previous number. Running from source
 * (`tsx src/index.ts`) has no define, hence the fallback.
 */
declare const __CLI_VERSION__: string | undefined;

export const CLI_VERSION = typeof __CLI_VERSION__ === 'string' ? __CLI_VERSION__ : '0.0.0-dev';
