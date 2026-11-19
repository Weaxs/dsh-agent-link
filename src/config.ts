import type { AgentConfig, PluginConfig } from './types.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

export function normalizeConfig(
  input: PluginConfig = {},
): Required<Pick<PluginConfig, 'agents' | 'jobTimeoutMs'>> & PluginConfig {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new ConfigError('config must be an object');
  if (input.agents !== undefined && !Array.isArray(input.agents)) throw new ConfigError('agents must be an array');
  const ids = new Set<string>();
  const agents = (input.agents ?? []).map((agent) => normalizeAgent(agent, ids));
  const timeout = input.jobTimeoutMs ?? 1_800_000;
  if (!Number.isSafeInteger(timeout) || timeout < 1_000 || timeout > 86_400_000) {
    throw new ConfigError('jobTimeoutMs must be between 1000 and 86400000');
  }
  if (input.mcp?.port !== undefined) port(input.mcp.port, 'mcp.port');
  return { ...input, agents, jobTimeoutMs: timeout };
}

function normalizeAgent(agent: AgentConfig, ids: Set<string>): AgentConfig {
  if (typeof agent !== 'object' || agent === null) throw new ConfigError('each agent must be an object');
  if (!ID.test(agent.id)) throw new ConfigError(`invalid agent id: ${String(agent.id)}`);
  if (ids.has(agent.id)) throw new ConfigError(`duplicate agent id: ${agent.id}`);
  ids.add(agent.id);
  if (!['hermes', 'openclaw', 'dsh'].includes(agent.kind))
    throw new ConfigError(`${agent.id}: kind must be hermes, openclaw, or dsh`);
  const transport = agent.transport ?? 'ssh';
  if (!['ssh', 'direct', 'local'].includes(transport)) throw new ConfigError(`${agent.id}: invalid transport`);
  if (agent.ssh !== undefined && (agent.ssh.startsWith('-') || !/^\S+$/.test(agent.ssh))) {
    throw new ConfigError(`${agent.id}: ssh must be one host alias without spaces`);
  }
  if (transport === 'ssh' && !agent.ssh) throw new ConfigError(`${agent.id}: ssh transport requires an ssh host alias`);
  const defaultPort = agent.kind === 'openclaw' ? 18_789 : agent.kind === 'dsh' ? 18_790 : 8_642;
  const result: AgentConfig = { ...agent, transport, port: agent.port ?? defaultPort };
  port(result.port!, `${agent.id}.port`);
  if (transport !== 'ssh' && !result.host) result.host = '127.0.0.1';
  if (result.host?.startsWith('-')) throw new ConfigError(`${agent.id}: invalid host`);
  if (
    result.connectTimeoutMs !== undefined &&
    (!Number.isSafeInteger(result.connectTimeoutMs) || result.connectTimeoutMs < 100)
  ) {
    throw new ConfigError(`${agent.id}: invalid connectTimeoutMs`);
  }
  return result;
}

function port(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new ConfigError(`${name} must be a TCP port`);
}

export function secret(agent: AgentConfig, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fallback =
    agent.kind === 'openclaw'
      ? 'OPENCLAW_GATEWAY_TOKEN'
      : agent.kind === 'dsh'
        ? 'DSH_GATEWAY_TOKEN'
        : 'HERMES_API_KEY';
  return agent.token ?? env[agent.tokenEnv ?? fallback];
}
