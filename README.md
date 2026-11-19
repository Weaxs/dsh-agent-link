# dsh-agent-link

Connect **DeepSeek Harness (dsh)** with **Hermes** and **OpenClaw** through their native gateway interfaces. No hosted relay, no cloud broker, and no Mesh plugin on remote hosts.

- **dsh → remote agents:** start tasks, continue remote sessions, receive streamed output, answer approvals, and cancel runs.
- **Remote agents → dsh:** expose explicitly allow-listed local dsh sessions through a read-only MCP endpoint.
- **Three transports:** system OpenSSH by default, direct connections with a Tailscale preset, and local loopback.
- **One installation:** only dsh installs this plugin. Remote agents keep their native gateway, credentials, tools, and sessions.

> Status: early development. Hermes uses the API Server (`/v1/runs` and SSE). OpenClaw uses the Gateway WebSocket pairing protocol. Always run `agent_link_doctor` after configuring a host.

## Packages

Both package names contain the same plugin:

- `@weaxs/dsh-agent-link`
- `dsh-agent-link`

## Install

From npm, inside DeepSeek Harness:

```text
Plugins → Add plugin → npm → @weaxs/dsh-agent-link
```

Or install a local checkout for development:

```bash
git clone https://github.com/Weaxs/dsh-agent-link.git
cd dsh-agent-link
npm ci
npm run build
```

Then add the absolute repository directory through **Plugins → Add plugin**. Restart dsh after replacing an installed package.

## Quick start

### 1. Configure Hermes

Start the Hermes API Server on the remote host and keep it on loopback when using SSH. The adapter uses these endpoints:

- `GET /health` and `GET /api/sessions`
- `POST /v1/runs`
- `GET /v1/runs/{id}` and `GET /v1/runs/{id}/events`
- `POST /v1/runs/{id}/approval` and `POST /v1/runs/{id}/stop`

Set the API bearer key in the local environment where dsh runs:

```bash
export HERMES_API_KEY='your-hermes-api-key'
```

See [Hermes programmatic integration](https://hermes-agent.nousresearch.com/docs/developer-guide/programmatic-integration) for the upstream API.

### 2. Configure OpenClaw

Keep OpenClaw Gateway on its trusted interface and configure its authentication token. Set the same token locally:

```bash
export OPENCLAW_GATEWAY_TOKEN='your-gateway-token'
```

The plugin creates one persistent Ed25519 device identity per configured agent under `$DSH_HOME/agent-link/devices`. Approve that device in OpenClaw on first use. The device key is never sent to the model or written to logs.

### 3. Add the dsh configuration

Add agents to the `agent-link` row in the profile's `cordis.patch.yml`:

```yaml
- id: agent-link
  name: '@weaxs/dsh-agent-link'
  config:
    agents:
      - id: hermes-gpu
        kind: hermes
        transport: ssh
        ssh: gpu-box
        port: 8642
      - id: claw-prod
        kind: openclaw
        transport: direct
        host: claw-server
        port: 18789
```

SSH is the default when `transport` is omitted. `gpu-box` is an alias from `~/.ssh/config`, not a command line. Read [the SSH guide](docs/SSH.md) before the first connection.

### 4. Check the connection

Ask dsh:

```text
Use agent_link_doctor to check every configured agent.
```

The doctor checks SSH configuration, non-interactive login, gateway reachability, and protocol health. It does not modify `~/.ssh/config` or accept unknown host keys.

## Model tools

| Tool | Purpose |
|---|---|
| `agent_list` | List configured agents and optionally probe their health. |
| `agent_ask` | Start a task and return a local `jobId`. Use `wait: true` for a synchronous call. |
| `agent_continue` | Send another message to the same remote session. |
| `agent_status` | Read streamed output, state, errors, and pending approvals. |
| `agent_cancel` | Cancel a running remote task. |
| `agent_respond` | Answer an approval using one of its offered choices. |
| `agent_link_doctor` | Diagnose transport, SSH, gateway, and protocol failures. |

Long tasks run in the background. When the originating dsh Agent supports `followup`, the plugin posts a completion notification back to that session.

## Share dsh sessions through MCP

The reverse endpoint is **read-only** in this release. It has its own listener and does not expose the dsh Web UI or its cookie-authenticated API.

Set a strong local token:

```bash
export DSH_AGENT_LINK_TOKEN='a-long-random-token'
```

Enable MCP and name every session that may be read. An empty list shares nothing:

```yaml
- id: agent-link
  name: '@weaxs/dsh-agent-link'
  config:
    mcp:
      enabled: true
      host: 127.0.0.1
      port: 19400
      allowSessions:
        - your-exact-dsh-session-id
    agents:
      - id: hermes-gpu
        kind: hermes
        ssh: gpu-box
```

MCP tools:

- `dsh_sessions_list`
- `dsh_session_read`
- `dsh_session_watch`

All returned content is recursively redacted for common tokens, bearer credentials, JWTs, cookies, and private keys. Requests require `Authorization: Bearer $DSH_AGENT_LINK_TOKEN`.

For a remote Hermes MCP configuration using SSH forwarding, use:

```yaml
mcp_servers:
  dsh:
    url: http://127.0.0.1:19400/mcp
    headers:
      Authorization: Bearer ${env:DSH_AGENT_LINK_TOKEN}
    trust: untrusted
```

The SSH reverse-forward setup and Tailscale alternative are described in [docs/DESIGN.md](docs/DESIGN.md).

## Transports

| Transport | Best for | Notes |
|---|---|---|
| `ssh` (default) | Existing SSH hosts | Uses `ssh -W` with `BatchMode=yes`; no password prompts or custom SSH cryptography. |
| `direct` | Tailscale, Headscale, LAN, or another trusted network | Uses the configured host and port; set `tls: true` for HTTPS/WSS. |
| `local` | Hermes or OpenClaw on the same machine | Defaults to `127.0.0.1`. |

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run check
```

See [AGENTS.md](AGENTS.md) for repository rules and [docs/DESIGN.md](docs/DESIGN.md) for the protocol architecture.

## Release

Releases run only through GitHub Actions. Add `NPM_TOKEN` to the repository secrets, then push a tag such as `v0.1.0`. The workflow verifies the tag against `package.json`, runs all checks, publishes both package names with provenance, and creates a GitHub Release.

## License

MIT
