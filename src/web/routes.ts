import type { Context } from '@deepseek-ai/cordis';
import { normalizeConfig } from '../config.js';
import { runDoctor } from '../doctor.js';
import type { AgentManager } from '../manager.js';
import type { McpServer } from '../mcp/server.js';
import type { SessionControllerLike } from '../mcp/session-service.js';
import { redact } from '../policy/redact.js';
import { loadStoredState, saveStoredState } from '../store.js';
import type { AgentConfig } from '../types.js';
import { VERSION } from '../version.js';

interface ConnectionHostFace {
  fetch?: {
    register?(route: {
      path: string;
      methods: readonly string[];
      requestBody: 'buffered';
      fetch: (request: Request) => Response | Promise<Response>;
    }): () => void;
  };
}

export const WEB_ROUTES = {
  state: '/api/dsh-knot/state',
  doctor: '/api/dsh-knot/doctor',
  respond: '/api/dsh-knot/respond',
  cancel: '/api/dsh-knot/cancel',
  sessions: '/api/dsh-knot/sessions',
  mcpShare: '/api/dsh-knot/mcp-share',
  agentSave: '/api/dsh-knot/agent-save',
  agentDelete: '/api/dsh-knot/agent-delete',
} as const;

function jsonReply(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

function errorReply(message: string, status = 400): Response {
  return jsonReply({ ok: false, error: message }, status);
}

async function parseBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function registerWebRoutes(
  ctx: Context,
  manager: AgentManager,
  mcp: McpServer | undefined,
  sessions: SessionControllerLike | undefined,
): void {
  const register = (path: string, handler: (request: Request) => Promise<Response>) => {
    const conn = (ctx as unknown as { connection?: ConnectionHostFace }).connection;
    if (typeof conn?.fetch?.register !== 'function') return;
    const dispose = conn.fetch.register({
      path,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: handler,
    });
    ctx.effect(() => dispose);
  };

  const mountAll = () => {
    register(WEB_ROUTES.state, async (request) => {
      try {
        const localSessions: Array<{ sessionId: string; title?: string; cwd?: string; shared: boolean }> = [];
        const allowed = new Set(mcp?.listAllowed() ?? []);
        if (sessions) {
          try {
            const listed = await sessions.list({}, request.signal);
            for (const item of listed.items.slice(0, 100)) {
              const id = String(item.sessionId ?? '');
              if (!id) continue;
              localSessions.push(
                redact({
                  sessionId: id,
                  title: item.title ? String(item.title) : undefined,
                  cwd: item.cwd ? String(item.cwd) : undefined,
                  shared: allowed.has(id),
                }),
              );
            }
          } catch {
            /* session list failure should not break the control panel state */
          }
        }
        return jsonReply({
          ok: true,
          value: {
            version: VERSION,
            agents: manager.list(),
            jobs: manager.listJobs().slice(0, 50),
            mcp: {
              enabled: Boolean(mcp?.address),
              address: mcp?.address ?? null,
              allowSessions: [...allowed],
              localSessions,
            },
          },
        });
      } catch (error) {
        return errorReply(error instanceof Error ? error.message : String(error), 500);
      }
    });

    register(WEB_ROUTES.doctor, async (request) => {
      try {
        const body = await parseBody(request);
        const agent = typeof body.agent === 'string' && body.agent.trim() ? body.agent.trim() : undefined;
        const result = await runDoctor(manager, agent, request.signal);
        return jsonReply({ ok: true, value: redact(result) });
      } catch (error) {
        return errorReply(error instanceof Error ? error.message : String(error), 400);
      }
    });

    register(WEB_ROUTES.respond, async (request) => {
      try {
        const body = await parseBody(request);
        const jobId = typeof body.jobId === 'string' ? body.jobId : '';
        const choice = typeof body.choice === 'string' ? body.choice : '';
        if (!jobId || !choice) return errorReply('jobId and choice are required', 400);
        const job = await manager.respond(jobId, choice, request.signal);
        return jsonReply({ ok: true, value: job });
      } catch (error) {
        return errorReply(error instanceof Error ? error.message : String(error), 400);
      }
    });

    register(WEB_ROUTES.cancel, async (request) => {
      try {
        const body = await parseBody(request);
        const jobId = typeof body.jobId === 'string' ? body.jobId : '';
        if (!jobId) return errorReply('jobId is required', 400);
        const job = await manager.cancel(jobId, request.signal);
        return jsonReply({ ok: true, value: job });
      } catch (error) {
        return errorReply(error instanceof Error ? error.message : String(error), 400);
      }
    });

    register(WEB_ROUTES.sessions, async (request) => {
      try {
        const body = await parseBody(request);
        const agentId = typeof body.agentId === 'string' ? body.agentId : '';
        if (!agentId) return errorReply('agentId is required', 400);
        const items = await manager.adapter(agentId).listSessions(request.signal);
        return jsonReply({ ok: true, value: { agentId, sessions: redact(items.slice(0, 100)) } });
      } catch (error) {
        return errorReply(error instanceof Error ? error.message : String(error), 400);
      }
    });

    register(WEB_ROUTES.mcpShare, async (request) => {
      try {
        if (!mcp?.address) return errorReply('MCP sharing is not enabled in plugin configuration', 400);
        const body = await parseBody(request);
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
        const allow = Boolean(body.allow);
        if (!sessionId) return errorReply('sessionId is required', 400);
        mcp.setAllowed(sessionId, allow);
        const allowSessions = mcp.listAllowed();
        const state = loadStoredState();
        saveStoredState({ ...state, allowSessions });
        return jsonReply({ ok: true, value: { allowSessions } });
      } catch (error) {
        return errorReply(error instanceof Error ? error.message : String(error), 400);
      }
    });

    register(WEB_ROUTES.agentSave, async (request) => {
      try {
        const body = await parseBody(request);
        const id = typeof body.id === 'string' ? body.id.trim() : '';
        const existing = id ? manager.getConfig(id) : undefined;
        const incomingToken = typeof body.token === 'string' ? body.token.trim() : '';
        const clearToken = body.clearToken === true;
        const kind = (body.kind ?? existing?.kind) as AgentConfig['kind'];
        const transport = ((body.transport ?? existing?.transport) as AgentConfig['transport']) ?? 'ssh';
        const resolvedToken = clearToken ? undefined : incomingToken || existing?.token;
        const resolvedTls = typeof body.tls === 'boolean' ? body.tls : existing?.tls;
        const acpTransport =
          kind === 'acp'
            ? body.acpTransport === 'stdio' || body.acpTransport === 'websocket'
              ? body.acpTransport
              : existing?.acpTransport
            : undefined;
        const acpCommand =
          kind === 'acp' && acpTransport === 'stdio'
            ? typeof body.acpCommand === 'string'
              ? body.acpCommand.trim() || undefined
              : existing?.acpCommand
            : undefined;
        const candidate: AgentConfig = {
          ...(existing ?? {}),
          id,
          kind,
          transport,
          ssh:
            typeof body.ssh === 'string'
              ? body.ssh.trim() || undefined
              : transport === 'ssh'
                ? existing?.ssh
                : undefined,
          host: typeof body.host === 'string' ? body.host.trim() || undefined : existing?.host,
          port: body.port !== undefined && body.port !== '' ? Number(body.port) : undefined,
          tls: resolvedTls ? true : undefined,
          token: resolvedToken,
          model: typeof body.model === 'string' ? body.model.trim() || undefined : existing?.model,
          acpTransport,
          acpCommand,
          ...(Array.isArray(body.acpArgs) ? { acpArgs: body.acpArgs.map(String) } : {}),
        };
        for (const key of Object.keys(candidate) as Array<keyof AgentConfig>) {
          if (candidate[key] === undefined) delete candidate[key];
        }
        const [normalized] = normalizeConfig({ agents: [candidate] }).agents;
        const state = loadStoredState();
        const agents = state.agents.filter((item) => item.id !== normalized!.id);
        agents.push(normalized!);
        const deletedIds = state.deletedIds.filter((item) => item !== normalized!.id);
        saveStoredState({ ...state, agents, deletedIds });
        await manager.upsert(normalized!);
        return jsonReply({ ok: true, value: { agents: manager.list() } });
      } catch (error) {
        return errorReply(error instanceof Error ? error.message : String(error), 400);
      }
    });

    register(WEB_ROUTES.agentDelete, async (request) => {
      try {
        const body = await parseBody(request);
        const id = typeof body.id === 'string' ? body.id.trim() : '';
        if (!id) return errorReply('id is required', 400);
        const state = loadStoredState();
        const agents = state.agents.filter((item) => item.id !== id);
        const deletedIds = [...new Set([...state.deletedIds, id])];
        saveStoredState({ ...state, agents, deletedIds });
        await manager.remove(id);
        return jsonReply({ ok: true, value: { agents: manager.list() } });
      } catch (error) {
        return errorReply(error instanceof Error ? error.message : String(error), 400);
      }
    });
  };

  if (typeof (ctx as unknown as { inject?: (deps: string[], cb: () => void) => void }).inject === 'function') {
    (ctx as unknown as { inject: (deps: string[], cb: () => void) => void }).inject(['connection'], mountAll);
  } else {
    mountAll();
  }
}
