# Agent Link design

Status: implemented initial architecture, with protocol compatibility continuing to evolve alongside Hermes, OpenClaw, and dsh release candidates.

## Goals

1. Let a dsh session run tasks on remote Hermes and OpenClaw agents, continue those sessions, stream results, answer approvals, and cancel work.
2. Let remote agents read and watch explicitly shared local dsh sessions through MCP.
3. Avoid third-party relays and avoid installing adapters on every remote harness.
4. Keep protocol details behind adapters and network details behind transports.

The current release intentionally does not write to local dsh sessions through MCP, mirror complete sessions, provide a cloud relay, or perform WebRTC NAT traversal.

## Layers

```text
┌──────────────────────── local dsh ────────────────────────┐
│ dsh-agent-link                                            │
│  adapters/    Hermes API Server, OpenClaw Gateway         │
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
  kind: 'hermes' | 'openclaw';
  health(signal?): Promise<Record<string, unknown>>;
  listSessions(signal?): Promise<AgentSession[]>;
  prompt(sessionId: string | undefined, text: string, signal?): AsyncIterable<AgentEvent>;
  cancel(sessionId: string, signal?): Promise<void>;
  respond?(sessionId: string, requestId: string, choice: string, signal?): Promise<void>;
  close(): Promise<void>;
}
```

`AgentEvent` is a small normalized vocabulary: text, tool activity, approval, final result, or error. Adapter-specific payloads never reach model tools directly.

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

- the `openclaw-control-ui` client descriptor,
- operator role and scopes,
- the gateway token,
- a persistent Ed25519 device identity and a signature over the v2 claim,
- the server nonce and the challenge's `ts` as `device.signedAt`.

Device keys live under `$DSH_HOME/agent-link/devices` with mode `0600`. The device ID is the SHA-256 hash of the public key's raw x coordinate. The signing format is isolated in `openclaw-identity.ts` so upstream protocol changes have one review point.

After pairing, the adapter uses `health`, `sessions.list`, `agent`, repeated `agent.wait` calls while a run is pending, and `sessions.abort` with the session `key`. RPC envelopes use `{ type: 'req', id, method, params }`, responses use `type: 'res'`, and streamed agent updates use `type: 'event'`. Reverse requests receive an explicit unsupported-method error instead of hanging.

OpenClaw protocol behavior still needs validation against every target deployment version. `agent_link_doctor` is the first compatibility check.

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

Implemented checks cover configuration, redaction, Hermes API/SSE normalization, OpenClaw pairing over a real WebSocket, device identity persistence, job lifecycle, local HTTP transport, and MCP authorization/read/watch behavior.

Remaining deployment milestones:

1. Validate Hermes and OpenClaw against real target versions and document their exact setup.
2. Add persistent reconnect supervision and richer approval routing where each gateway supports it.
3. Add a small sidebar status panel and Tailscale node discovery.
4. Consider explicit write-enabled MCP sessions only after the read-only security boundary has been exercised.

## Repository references

- [Hermes programmatic integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration)
- [ODSH-Bridge OpenClaw pairing reference](https://github.com/Mikoribbit/odsh-bridge)
- [OpenClaw Gateway handshake](https://docs.openclaw.ai/gateway/protocol/handshake)
- [Transport integration test infrastructure](E2E.md)
- [SSH setup guide](SSH.md)
