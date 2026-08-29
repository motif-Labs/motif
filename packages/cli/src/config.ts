import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface MotifConfig {
  serverUrl?: string;
  /** Team token — bootstrap/registration and read-only dashboard login. */
  token?: string;
  /** Per-device member token — identity for every write; minted by `motif connect`. */
  memberToken?: string;
  memberId?: number;
  name?: string;
  email?: string;
  /** Project paths (supports `*` and `**` globs) the daemon must never sync. */
  exclude?: string[];
  /** Regexes applied to message text before anything leaves this machine. */
  redactPatterns?: string[];
}

export function motifHome(): string {
  return process.env.MOTIF_HOME ?? path.join(os.homedir(), '.motif');
}

export function configPath(): string {
  return path.join(motifHome(), 'config.json');
}

export function loadConfig(): MotifConfig {
  try {
    return JSON.parse(fs.readFileSync(configPath(), 'utf8')) as MotifConfig;
  } catch {
    return {};
  }
}

export function saveConfig(cfg: MotifConfig): void {
  fs.mkdirSync(motifHome(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n');
}

export function requireConnection(cfg: MotifConfig): asserts cfg is MotifConfig & {
  serverUrl: string;
  memberToken: string;
  memberId: number;
} {
  if (!cfg.serverUrl || !cfg.memberToken || cfg.memberId === undefined) {
    throw new Error('Not connected to a Motif server. Run: motif connect <url> --token <token> --name <you>');
  }
}
