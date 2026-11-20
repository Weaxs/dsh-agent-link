import type { Context } from '@deepseek-ai/cordis';
import { normalizeConfig } from './config.js';
import { AgentManager } from './manager.js';
import { McpServer } from './mcp/server.js';
import type { SessionControllerLike } from './mcp/session-service.js';
import { registerTools } from './tools.js';
import type { PluginConfig } from './types.js';

export const name = 'knot';
export const inject = ['tools'];

export async function apply(ctx: Context, input: PluginConfig = {}): Promise<void> {
  const config = normalizeConfig(input);
  const manager = new AgentManager(config.agents, config.jobTimeoutMs);
  registerTools(ctx, manager);
  let mcp: McpServer | undefined;
  if (config.mcp?.enabled) {
    const sessions = (ctx as unknown as { sessionController?: SessionControllerLike }).sessionController;
    if (!sessions) throw new Error('MCP sharing requires the dsh sessionController service');
    mcp = new McpServer(config.mcp, sessions);
    await mcp.start();
  }
  ctx.effect(() => async () => {
    await mcp?.close();
    await manager.close();
  });
}

export { AcpBridge, createAcpAgent, runAcpStdio } from './acp/bridge.js';
export { AcpAdapter } from './adapters/acp.js';
export { DshAdapter } from './adapters/dsh.js';
export { HermesAdapter } from './adapters/hermes.js';
export { createNativeAdapter, createNativeSessionId } from './adapters/native.js';
export { OpenClawAdapter } from './adapters/openclaw.js';
export { normalizeConfig } from './config.js';
export { runDoctor, sshHint } from './doctor.js';
export { AgentManager } from './manager.js';
export { McpServer } from './mcp/server.js';
export { redact, redactText } from './policy/redact.js';
export { NodeHttpTransport, transportFor } from './transports/http.js';
export { StdioSocket, sshArguments } from './transports/stdio-socket.js';
export type * from './types.js';
