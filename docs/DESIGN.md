# Agent Link design

Status: native and unified ACP v1 paths validated by real model-backed E2E across 24 transport/target/protocol combinations.

## Goals

1. Let a dsh session run tasks on remote Hermes, OpenClaw, and dsh agents, continue those sessions, stream results, answer approvals where supported, and cancel work.
2. Let remote agents read and watch explicitly shared local dsh sessions through MCP.
3. Avoid third-party relays and avoid installing adapters on every remote harness.
4. Keep protocol details behind adapters and network details behind transports.

The current release intentionally does not write to local dsh sessions through MCP, mirror complete sessions, provide a cloud relay, or perform WebRTC NAT traversal.

## Layers

```text
┌──────────────────────── local dsh ────────────────────────┐
│ dsh-agent-link                                            │
│  adapters/    ACP provider + native compatibility drivers │
│  transports/  ssh (default), direct, local                │
│  tools/       agent_list / agent_ask / agent_continue / … │
│  manager      jobs, output, cancellation, notifications   │
│  mcp/         read-only session export                    │
│  policy/      allow-list, bearer authentication, redaction│
└────────────┬────────────────────────────────▲─────────────┘
             │ forward: dsh → Agent            │ reverse: Agent → dsh MCP
     ┌───────▼────────┐                ┌───────┴─────────┐
     │ Hermes API     │                │ OpenClaw Gateway│
     │ Server         │                │ WebSocket       │
     └────────────────┘                └─────────────────┘
```

Adapters own message semantics. Transports own connectivity. Neither layer contains the other layer's configuration or protocol assumptions.

## Protocol adapters

### Shared adapter contract

```ts
interface AgentAdapter {
  id: string;
  kind: 'hermes' | 'openclaw' | 'dsh' | 'acp';
  health(signal?): Promise<Record<string, unknown>>;
  listSessions(signal?): Promise<AgentSession[]>;
  prompt(sessionId: string | undefined, text: string, signal?): AsyncIterable<AgentEvent>;
  cancel(sessionId: string, signal?): Promise<void>;
  respond?(sessionId: string, requestId: string, choice: string, signal?): Promise<void>;
  close(): Promise<void>;
}
```

`AgentEvent` is a small normalized vocabulary: text, tool activity, approval, final result, or error. Adapter-specific payloads never reach model tools directly.

### ACP v1 provider and bridge

The `acp` kind is the single provider for any ACP-compatible endpoint. The official TypeScript SDK negotiates stable protocol v1 and carries JSON-RPC messages over its WebSocket transport or standard NDJSON stdio. Stdio supports local subprocesses and ACP commands started through system OpenSSH. Session aliases are mapped to the actual ACP `sessionId`, so subsequent prompts continue the same conversation. The client uses the SDK's `ActiveSession` plus one event queue to preserve update/stop ordering without losing permission events to abandoned race waiters.

The optional `dsh-agent-link-acp` bridge exposes `initialize`, `session/new`, `session/list`, `session/prompt`, `session/cancel`, `session/update`, and `session/request_permission` over WebSocket or `AGENT_LINK_ACP_STDIO=1` stdio mode. Each bridge connection constructs a native adapter for Hermes, OpenClaw, or remote DSH and translates only that adapter's normalized events. A native ACP endpoint bypasses the bridge entirely. Non-loopback bridge listeners require `AGENT_LINK_ACP_TOKEN`; native gateway credentials and ACP bearer tokens remain separate.

ACP v2, A2A, and additional UI transports are intentionally outside the current scope.

### Hermes

The adapter uses the native API Server:

- `POST /v1/runs` with `{ input, session_id, model? }` and an `Idempotency-Key`.
- `GET /v1/runs/{id}/events` for Server-Sent Events.
- `GET /v1/runs/{id}` as a terminal-status fallback.
- `POST /v1/runs/{id}/approval` for approval responses.
- `POST /v1/runs/{id}/stop` for cancellation.
- `GET /health` and `GET /api/sessions` for discovery and health.

Authentication uses `Authorization: Bearer …`, read from `token` or `tokenEnv` (default `HERMES_API_KEY`). The token is not logged.

### OpenClaw

The adapter opens a Gateway WebSocket with subprotocol `json`, negotiates protocol version 4, waits for `connect.challenge`, and sends a `connect` request containing:

- the `cli` client descriptor with `cli` mode, operator role, and the actual host platform,
- operator role and scopes,
- the gateway token,
- a persistent Ed25519 device identity and a signature over the v2 claim,
- the server nonce and the challenge's `ts` as `device.signedAt`.

Device keys live under `$DSH_HOME/agent-link/devices` with mode `0600`. The device ID is the SHA-256 hash of the public key's raw x coordinate. The signing format is isolated in `openclaw-identity.ts` so upstream protocol changes have one review point.

After pairing, the adapter uses `health`, `sessions.list`, `agent`, repeated `agent.wait` calls while a run is pending, and `sessions.abort` with the session `key`. RPC envelopes use `{ type: 'req', id, method, params }`, responses use `type: 'res'`, and streamed agent updates use `type: 'event'`. Reverse requests receive an explicit unsupported-method error instead of hanging.

OpenClaw protocol behavior still needs validation against every target deployment version. `agent_link_doctor` is the first compatibility check.

### Remote DSH

The DSH adapter uses the native Web/API connection rather than the plugin's read-only MCP listener. `GET /connect?token=...&interactions=none` exchanges the launch token for an API Cookie. Calls then use the Connection envelope `{ type: 'client-request', rpcId, method: 'session/<method>', payload: { args } }` and check the nested `{ ok: true, value }` result.

Session work uses `session/create`, optional `session/selectModel`, `session/prompt`, repeated `session/wait` calls while the Session is active, `session/list` for discovery, and `session/cancel` for cancellation. RPC arguments use the Remote method's parameter envelope (`request`, or `_request` for `session/list`). The adapter remembers requested-to-actual Session ID mappings so continuations prompt the existing Session instead of creating a new one. Assistant text is read only from durable `assistant/message.data.message.content` records; an empty wait output triggers a durable event read so model failures are reported instead of becoming empty successful jobs. The launch token and API Cookie are never logged.

Remote deployments should keep the native listener on loopback for SSH or configure a concrete bind IP and `--trusted-host` for a private network. The CI container uses a test-only Host-rewrite bridge to preserve that trust boundary.

## Transports

### SSH (default)

The plugin executes the system OpenSSH binary directly:

```text
ssh -T -o BatchMode=yes -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    -W 127.0.0.1:<gateway-port> <host-alias>
```

It does not implement SSH, accept passwords, or handle private-key passphrases interactively. Host aliases come from `~/.ssh/config`; OpenSSH owns key types, algorithms, proxy commands, jump hosts, and host-key verification.

For HTTP requests, one SSH process carries one request or SSE stream through a `Duplex` stdio socket. For OpenClaw, one process carries the persistent WebSocket connection. This avoids opening a local forwarding port.

### Direct

`direct` uses the configured hostname and port, with optional TLS. It is intended for Tailscale, Headscale, a LAN, or another trusted network. The Tailscale preset is configuration guidance rather than a separate protocol implementation: use MagicDNS hostnames and restrict gateway listeners and ACLs to the tailnet.

### Local

`local` is the direct transport with `127.0.0.1` as the default host.

## Jobs and model tools

`agent_ask` and `agent_continue` create a local job and return its ID immediately unless `wait: true` is supplied. The manager:

- generates a remote session ID when needed,
- accumulates streamed output with a bounded in-memory limit,
- records pending approvals,
- forwards cancellation to the adapter,
- enforces the configured timeout,
- optionally calls `Agent.followup()` on completion.

The originating Agent's `followup` receives a marked `source.kind: agent-link` message. Missing follow-up support does not fail the remote job.

## Reverse MCP endpoint

The MCP server is a separate HTTP listener, not a route on the dsh Web server. Exposing the dsh Web server would expose its browser UI, plugin routes, and cookie-authenticated API.

The endpoint supports JSON-RPC `initialize`, `ping`, `tools/list`, and `tools/call`, including notification handling and batch requests. It implements Streamable HTTP POST semantics without opening a public SSE endpoint.

Tools:

| Tool                | Behavior                                                                | Permission |
| ------------------- | ----------------------------------------------------------------------- | ---------- |
| `dsh_sessions_list` | List only allow-listed dsh sessions.                                    | read       |
| `dsh_session_read`  | Read a message-aligned history page through `sessionController.events`. | read       |
| `dsh_session_watch` | Follow a session and return new frames plus a cursor.                   | read       |

Authentication uses a bearer token from `token` or `tokenEnv` (default `DSH_AGENT_LINK_TOKEN`). Startup fails closed if MCP is enabled without a token. `allowSessions` defaults to an empty set.

### Reverse networking

With SSH, a reverse forward may map remote `127.0.0.1:19400` to the local MCP listener. With Tailscale, bind MCP to the local Tailscale address and use MagicDNS. The listener should never bind `0.0.0.0` merely to make connectivity easier.

The current release has no `dsh_session_post` tool. Adding write access later requires a separate write token, explicit per-session write permission, origin markers, and loop prevention.

## Security

- Deny session access by default.
- Keep gateways and MCP on loopback or a trusted tailnet interface.
- Redact common bearer tokens, API keys, JWTs, cookies, and private keys recursively before returning MCP content.
- Do not log remote tokens, device private keys, or complete SSH configuration.
- Answer remote approvals through the user; never automatically approve by default.
- Spawn OpenSSH directly without a shell.
- Reuse persistent gateways instead of launching new agent services on every reconnect.
- Bound request bodies, response bodies, watch payloads, and retained job output.

## Validation and milestones

Implemented checks cover configuration, redaction, Hermes API/SSE normalization, OpenClaw pairing over a real WebSocket, device identity persistence, native DSH Session RPC, ACP prompt/continuation/tool/permission/cancel flows over the official WebSocket transport and a real NDJSON stdio subprocess, job lifecycle, local and SSH HTTP transports, and MCP authorization/read/watch behavior. The transport matrix also completes real model-backed initial tasks and same-session continuations for Hermes, OpenClaw, and remote DSH over Local, SSH, Tailscale, and Headscale.

Remaining deployment milestones:

1. Add persistent reconnect supervision and richer approval routing where each gateway supports it.
2. Add a small sidebar status panel and Tailscale node discovery.
3. Consider explicit write-enabled MCP sessions only after the read-only security boundary has been exercised.

## Repository references

- [Agent Client Protocol](https://agentclientprotocol.com)
- [Official ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [Hermes programmatic integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)
- [ODSH-Bridge OpenClaw pairing reference](https://github.com/Mikoribbit/odsh-bridge)
- [OpenClaw Gateway handshake](https://docs.openclaw.ai/gateway/protocol/handshake)
- [Transport integration test infrastructure](E2E.md)
- [SSH setup guide](SSH.md)
