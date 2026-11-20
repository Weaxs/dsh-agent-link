# dsh-agent-link — Agent Guidelines

Read this file and the relevant design doc before changing code.

## Single sources of truth

Read the authoritative doc before modifying its subsystem; keep docs minimal with pointers instead of duplicating rules:

- Architecture, protocol contracts, and security boundaries: [docs/DESIGN.md](docs/DESIGN.md)
- SSH provider setups and failure modes: [docs/SSH.md](docs/SSH.md)
- Real model-backed 24-job E2E matrix and required secrets: [docs/E2E.md](docs/E2E.md)
- Installation, configuration, tools, MCP, and release usage: [README.md](README.md)

## Architecture & ownership

`dsh-agent-link` connects DeepSeek Harness (dsh) with Hermes, OpenClaw, and remote dsh instances via ACP v1 or native gateway interfaces, and exports allow-listed local dsh sessions over a read-only MCP listener.

Keep module boundaries strict — never mix protocol logic into transports or transport branches into adapters:

- `src/adapters/` — gateway protocols and event normalization (`acp.ts` is the single ACP v1 provider; `hermes.ts`, `openclaw.ts`, `openclaw-identity.ts`, `dsh.ts`, `sse.ts`, `gateway-ws.ts` are native drivers).
- `src/transports/` — connectivity and process/socket lifecycles (`http.ts`, `stdio-socket.ts`).
- `src/manager.ts` — local jobs, bounded output, timeouts, cancellation, and completion notifications.
- `src/tools.ts` — model-facing dsh tool contract.
- `src/acp/` — reusable ACP v1 bridge and CLI (`bridge.ts`, `cli.ts`); native adapters stay behind this boundary.
- `src/mcp/` — separate read-only MCP listener (`server.ts`, `session-service.ts`).
- `src/policy/` — recursive redaction and constant-time bearer verification (`redact.ts`, `auth.ts`).
- `src/version.ts` — single runtime version constant synced with `package.json` by `scripts/sync-version.mjs`.

Prefer the shared ACP provider for compatible platforms; a new native-only platform gets a native adapter behind the bridge, and a new network path gets a new transport.

## Workflow

1. **Scope & read first**: Read the relevant design doc, source module, and existing tests before editing. Do not guess dsh runtime APIs — verify `sessionController` (`list`, `events`, `follow`) and `defineTool` signatures against the installed `@deepseek-ai/*` types.
2. **Smallest surgical change**: Write the minimal change that fully solves the problem. Avoid over-engineering, zero-value wrappers, and code duplication. Delete dead code and obsolete tests instead of keeping fallbacks.
3. **Verify before reporting**: Run the narrowest targeted test first, then run the full quality gate before committing. Never claim a mock test proves live gateway compatibility.

## Invariants

1. **No relays**: Never introduce a hosted relay, cloud broker, or mandatory remote plugin without an explicit user request.
2. **Deny-by-default MCP**: Only explicitly allow-listed dsh sessions are exposed; an empty `allowSessions` shares nothing. Check allow-list before reading session data.
3. **Read-only MCP**: MCP remains read-only until a separate write-token, per-session write permission, origin marker, and loop-prevention design is implemented.
4. **Fail closed & loopback/tailnet only**: MCP fails closed without a bearer token and refuses `0.0.0.0` / `::`. Non-loopback ACP bridges require `AGENT_LINK_ACP_TOKEN`. Compare bearer tokens in constant time (`verifyBearerToken`).
5. **No secret leakage**: Tokens, cookies, private keys, full remote configs, and session contents are never logged. Redact recursively (with circular-reference protection) before returning MCP payloads.
6. **System OpenSSH only**: Invoke `ssh` via `execFile`/`spawn` without a shell, always with `BatchMode=yes`, `ConnectTimeout`, `ServerAliveInterval`/`ServerAliveCountMax`, and `ExitOnForwardFailure=yes`. Never auto-accept unknown host keys, weaken global algorithms, or edit `~/.ssh/config`.
7. **Honest errors & approvals**: Surface gateway failures as structured errors; never fabricate success or hide partial output. Surface remote approvals to the user; never auto-approve.
8. **Normalized events**: Adapter-specific payloads stop at `src/adapters/`. Tools and jobs consume normalized `AgentEvent` only.
9. **Package parity**: `@weaxs/dsh-agent-link` and `dsh-agent-link` carry identical behavior; `cordis.patch.yml` must name the package being published.

## dsh integration rules

- Register tools via `defineTool` from `@deepseek-ai/dsh-tools`. Keep names `agent_list`, `agent_ask`, `agent_continue`, `agent_status`, `agent_cancel`, `agent_respond`, and `agent_link_doctor` unless a deliberate migration is designed.
- Keep tool output JSON-serializable and rendered as a single text block containing that JSON.
- Forward `exec.signal` into all network calls, waits, doctor checks, and remote cancellations.
- Call `Agent.followup()` only when present; notification failures must never fail a remote job.
- Register teardown via `ctx.effect()` to close MCP listeners, sockets, WebSockets, child processes, and abort active job controllers on unload.
- Keep `@deepseek-ai/*` as `peerDependencies`; never bundle a second dsh runtime.

## Coding, memory & performance standards

- English only for code, tests, docs, commits, and PRs.
- TypeScript strict mode, ESM, `NodeNext` resolution, explicit `.js` import extensions.
- Prefer Node.js standard library; add dependencies only when they remove substantial protocol or security complexity.
- Comments explain non-obvious protocol invariants or lifecycle hazards only; remove narration that repeats the code.
- **Long-running hygiene**: Strictly prevent memory leaks, dangling listeners, and unbounded state growth:
  - Bound all in-memory maps/queues/buffers (`jobs`, `runs`, `cursors`, `sessionIds`, response/SSE/batch sizes) and evict finished entries.
  - Always `removeEventListener('abort', ...)` and `clearTimeout(...)` in `finally` blocks.
  - Always `destroy()` HTTP streams and `kill()` child processes in `finally` / `close()`.
  - Do not silently swallow errors except during best-effort cleanup or notification delivery (comment that boundary explicitly).

## Known pitfalls & durable lessons

Check every change against these recurring failure modes:

- **`Promise.race` + `AsyncQueue` waiter leaks**: Never call `queue.next()` inside a `Promise.race` loop without an `AbortSignal` cleanup or reusing the pending promise — abandoned waiters silently steal subsequent events from the queue.
- **SSH stdio shell quoting**: `spawn('ssh', args)` runs without a local shell. Never shell-quote local `ssh` flags (like `-F <path with spaces>`); shell-quote only the remote command and its arguments using single-quote escaping (`shellQuote`).
- **Multi-byte UTF-8 chunk splitting**: Never call `chunk.toString('utf8')` per TCP chunk on streaming text (SSE, HTTP bodies, stderr). Use `StringDecoder('utf8')` or `Buffer.concat`.
- **Stream backpressure & error events**: Respect `this.push(chunk)` return values in `StdioSocket` (`pause`/`resume`), and always attach `response.on('error', reject)` on HTTP error-status streams.
- **Cancel vs. completion races**: `manager.cancel()` must abort the job's local `AbortController` as well as calling `adapter.cancel()`, and `run()` must not overwrite `'cancelled'` back to `'completed'` or `'failed'`.
- **Yielding in `finally`**: Avoid `yield` inside `finally` blocks of async generators; run stream-end fallbacks after the `for await` loop inside `try` so real stream errors are not masked.
- **Cross-session permission isolation**: Scope pending approval/permission maps by `sessionId` so cancelling one session never cancels another session's approval.
- **Release YAML quote drift**: When rewriting `cordis.patch.yml` in `.github/workflows/release.yml`, verify against the actual quote style used in `cordis.patch.yml` and keep `src/version.ts` synced with `package.json`.

## Verification gates

Run the narrowest relevant test first:

```bash
npx vitest run tests/<name>.test.ts -t "<case>"
```

Before every commit:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Before a release or substantial change:

```bash
npm run check
```

Behavioral test requirements:

- Cover behavior, not just types: Hermes runs/SSE/fallback/cancel/approvals; OpenClaw handshake/RPC/session continuation over real WS; DSH native RPC/cookie refresh; ACP WS & stdio prompt/continuation/tools/permissions/cancel; SSH arg safety & doctor; MCP auth/allow-list/redaction/read/watch/limits; plugin entry, tools, and job lifecycle.
- Real model-backed E2E lives in `.github/e2e/` and `.github/workflows/e2e.yml` (24-job matrix). Never replace real services with mocks, silently skip missing credentials, or treat `/health` as E2E.

## Commit & release hygiene

- Stage only intentional files (never blanket `git add -A`); review the full diff before committing.
- Never commit `dist/`, `node_modules/`, `coverage/`, tarballs, `.tmp/`, credentials, device keys, or `.env` files.
- Releases are tag-triggered (`v<semver>`) via GitHub Actions with `secrets.NPM_TOKEN`; never publish from a workstation.
- Report unit test results, build results, live-host validation limits, and any remaining protocol assumptions separately.
