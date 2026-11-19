#!/usr/bin/env node
import type { AgentConfig, AgentKind } from '../types.js';
import { AcpBridge } from './bridge.js';

const kind = process.env.AGENT_LINK_NATIVE_KIND;
if (!kind || !['hermes', 'openclaw', 'dsh'].includes(kind)) {
  throw new Error('AGENT_LINK_NATIVE_KIND must be hermes, openclaw, or dsh');
}
const defaultPort = kind === 'openclaw' ? 18_789 : kind === 'dsh' ? 18_790 : 8_642;
const config: AgentConfig = {
  id: process.env.AGENT_LINK_NATIVE_ID ?? `${kind}-acp-bridge`,
  kind: kind as AgentKind,
  transport: 'local',
  host: process.env.AGENT_LINK_NATIVE_HOST ?? '127.0.0.1',
  port: Number(process.env.AGENT_LINK_NATIVE_PORT ?? defaultPort),
  ...(process.env.AGENT_LINK_NATIVE_TOKEN ? { token: process.env.AGENT_LINK_NATIVE_TOKEN } : {}),
  model: process.env.OPENAI_MODEL_NAME,
  dshProvider: process.env.AGENT_LINK_DSH_PROVIDER,
  dshCwd: process.env.AGENT_LINK_NATIVE_CWD,
  openclawAgentId: process.env.AGENT_LINK_OPENCLAW_AGENT_ID,
  reasoningEffort: process.env.AGENT_LINK_REASONING_EFFORT,
};
const bridge = new AcpBridge(config);
const address = await bridge.start({
  host: process.env.AGENT_LINK_ACP_HOST,
  port: Number(process.env.AGENT_LINK_ACP_PORT ?? 18_792),
  token: process.env.AGENT_LINK_ACP_TOKEN,
});
console.log(`ACP bridge for ${kind} listening on ${address.host}:${address.port}`);
for (const event of ['SIGINT', 'SIGTERM']) {
  process.once(event, () => {
    void bridge.close().then(() => {
      process.exitCode = 0;
    });
  });
}
