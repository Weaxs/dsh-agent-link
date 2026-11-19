import type { Context } from '@deepseek-ai/cordis'
import { normalizeConfig } from './config.js'
import { AgentManager } from './manager.js'
import { registerTools } from './tools.js'
import type { PluginConfig } from './types.js'
import { McpServer } from './mcp/server.js'
import type { SessionControllerLike } from './mcp/session-service.js'

export const name = 'agent-link'
export const inject = ['tools']

export async function apply(ctx: Context, input: PluginConfig = {}): Promise<void> {
  const config = normalizeConfig(input)
  const manager = new AgentManager(config.agents, config.jobTimeoutMs)
  registerTools(ctx, manager)
  let mcp: McpServer | undefined
  if (config.mcp?.enabled) {
    const sessions = (ctx as unknown as { sessionController?: SessionControllerLike }).sessionController
    if (!sessions) throw new Error('MCP sharing requires the dsh sessionController service')
    mcp = new McpServer(config.mcp, sessions)
    await mcp.start()
  }
  ctx.effect(() => async () => {
    await mcp?.close()
    await manager.close()
  })
}

export { AgentManager } from './manager.js'
export { HermesAdapter } from './adapters/hermes.js'
export { OpenClawAdapter } from './adapters/openclaw.js'
export { McpServer } from './mcp/server.js'
export { normalizeConfig } from './config.js'
export { sshArguments, StdioSocket } from './transports/stdio-socket.js'
export { NodeHttpTransport, transportFor } from './transports/http.js'
export { redact, redactText } from './policy/redact.js'
export { runDoctor, sshHint } from './doctor.js'
export type * from './types.js'
