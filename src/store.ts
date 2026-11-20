import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { normalizeConfig } from './config.js';
import type { AgentConfig } from './types.js';

export function defaultAgentsFile(): string {
  const dir = process.env.DSH_KNOT_STATE_DIR ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'knot');
  return join(dir, 'agents.json');
}

export function loadStoredAgents(file = defaultAgentsFile()): AgentConfig[] {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return normalizeConfig({ agents: raw as AgentConfig[] }).agents;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [];
  }
}

export function saveStoredAgents(agents: AgentConfig[], file = defaultAgentsFile()): AgentConfig[] {
  const normalized = normalizeConfig({ agents }).agents;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
  return normalized;
}
