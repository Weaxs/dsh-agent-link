import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { runDoctor } from './doctor.js';
import type { AgentManager } from './manager.js';

const output = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
};

export function registerTools(ctx: Context, manager: AgentManager): void {
  ctx.tools.register(
    defineTool({
      name: 'agent_list',
      description: 'List remote Hermes, OpenClaw, and DSH agents configured through dsh-agent-link.',
      parameters: { health: { type: 'boolean', description: 'Also probe every agent gateway.' } },
      output,
      async execute(args) {
        const agents = manager.list();
        if (!args.health) return { agents };
        return {
          agents: await Promise.all(
            agents.map(async (agent) => {
              try {
                return { ...agent, health: await manager.adapter(agent.id).health() };
              } catch (error) {
                return { ...agent, health: { ok: false, error: message(error) } };
              }
            }),
          ),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'agent_ask',
      description:
        'Start a task on a remote Hermes, OpenClaw, or DSH agent. Returns a job id immediately; use agent_status to read progress and agent_continue for follow-ups.',
      parameters: {
        agent: { type: 'string', required: true },
        task: { type: 'string', required: true },
        session: { type: 'string', description: 'Optional remote session id to continue.' },
        wait: { type: 'boolean', description: 'Wait for completion before returning.' },
      },
      output,
      async execute(args, exec) {
        const job = manager.start(args.agent, args.task, args.session, (completed) => notifyAgent(exec, completed));
        return plain(args.wait ? await manager.wait(job.id) : job);
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'agent_continue',
      description: 'Send a follow-up message to the same remote Hermes, OpenClaw, or DSH session.',
      parameters: {
        agent: { type: 'string', required: true },
        session: { type: 'string', required: true },
        message: { type: 'string', required: true },
        wait: { type: 'boolean' },
      },
      output,
      async execute(args, exec) {
        const job = manager.start(args.agent, args.message, args.session, (completed) => notifyAgent(exec, completed));
        return plain(args.wait ? await manager.wait(job.id) : job);
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'agent_status',
      description: 'Read a remote agent job, including streamed text and pending approvals.',
      parameters: {
        job: { type: 'string', required: true },
        wait: { type: 'boolean', description: 'Wait for the job to finish.' },
      },
      output,
      async execute(args) {
        return plain(args.wait ? await manager.wait(args.job) : manager.get(args.job));
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'agent_cancel',
      description: 'Cancel a running task on a remote Hermes, OpenClaw, or DSH agent.',
      parameters: { job: { type: 'string', required: true } },
      output,
      async execute(args) {
        return plain(await manager.cancel(args.job));
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'agent_respond',
      description: 'Answer a pending approval emitted by a remote agent job.',
      parameters: {
        job: { type: 'string', required: true },
        choice: { type: 'string', required: true, description: 'The exact choice offered by the remote agent.' },
      },
      output,
      async execute(args) {
        return plain(await manager.respond(args.job, args.choice));
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'agent_link_doctor',
      description: 'Check transport, SSH, gateway reachability and protocol health for configured agents.',
      parameters: { agent: { type: 'string', description: 'Check one agent id; omit to check all.' } },
      output,
      async execute(args) {
        return plain(await runDoctor(manager, args.agent));
      },
    }),
  );
}

function plain(value: unknown): any {
  return JSON.parse(JSON.stringify(value));
}

function notifyAgent(exec: { agent?: unknown }, job: unknown): void {
  const agent = exec.agent as { followup?: (message: unknown) => void } | undefined;
  if (!agent?.followup) return;
  agent.followup({
    role: 'user',
    content: [{ type: 'text', text: `Remote agent job update:\n${JSON.stringify(job)}` }],
    source: { kind: 'agent-link' },
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
