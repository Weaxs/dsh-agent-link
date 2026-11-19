# dsh-agent-link — Agent Guidelines

## Project overview

`dsh-agent-link` connects DeepSeek Harness (dsh) with Hermes and OpenClaw through their native gateway interfaces. It provides model tools for remote tasks and a read-only MCP endpoint for allow-listed local dsh sessions.

The architectural boundary is strict:

- `src/adapters/` owns gateway protocols and event normalization.
- `src/transports/` owns connectivity and process/socket lifecycles.
- `src/manager.ts` owns local jobs, output, timeouts, cancellation, and completion notifications.
- `src/tools.ts` owns the model-facing dsh tool contract.
- `src/mcp/` owns the separate read-only MCP listener.
- `src/policy/` owns redaction and other disclosure controls.

Do not mix these responsibilities. A new remote platform gets a new adapter; a new network path gets a new transport. Do not add transport branches to protocol adapters.

## Invariants

1. No hosted relay, cloud broker, or mandatory remote plugin is introduced without an explicit user request.
2. Only explicitly allow-listed dsh sessions are exposed through MCP. An empty list shares nothing.
3. MCP remains read-only until a separate write-token, per-session write permission, origin marking, and loop-prevention design is implemented.
4. Tokens, private keys, full remote configuration, and session contents are never logged.
5. SSH is executed through the system OpenSSH binary without a shell. The plugin does not implement SSH or change `~/.ssh/config`.
6. Remote gateway failures are surfaced as structured errors; do not fabricate successful results or hide partial output.
7. Adapter-specific response shapes stop at the adapter. Tools and jobs use normalized events only.
8. The scoped and unscoped packages carry the same behavior. `cordis.patch.yml` must name the package being published.

## dsh integration rules

- Use the official `defineTool` registration path from `@deepseek-ai/dsh-tools`. Tool names remain `agent_list`, `agent_ask`, `agent_continue`, `agent_status`, `agent_cancel`, `agent_respond`, and `agent_link_doctor` unless a deliberate migration is designed.
- Keep JSON output serializable and renderer output a single text block containing that JSON.
- Forward `exec.signal` into network requests and remote work. Do not leave work running after cancellation.
- Use `Agent.followup()` only when available. Missing follow-up support never fails a remote job.
- Access `sessionController` only through its documented `list`, `events`, and `follow` interfaces. Re-check those signatures against the running dsh version before changing MCP behavior.
- Register cleanup through `ctx.effect()` and close the MCP listener, sockets, WebSockets, and adapters on unload.
- Keep `@deepseek-ai/*` packages as peer dependencies. Do not bundle a second dsh runtime.

## Coding standards

- English only for code, tests, documentation, commit messages, and pull requests.
- TypeScript strict mode, ESM, NodeNext resolution, and explicit `.js` extensions in source imports.
- Prefer small modules and standard-library facilities. Add a dependency only when it removes meaningful protocol or security complexity.
- Match existing naming and error handling before introducing another pattern.
- Comments are reserved for non-obvious protocol invariants and lifecycle hazards. Remove narration that repeats the code.
- Avoid unbounded arrays, response bodies, retained logs, reconnect loops, and background tasks.
- Do not silently swallow errors except during best-effort cleanup or notification delivery, where the comment must make that boundary clear.

## Transport and protocol rules

- SSH always uses `BatchMode=yes`, connection timeouts, keepalives, and `ExitOnForwardFailure=yes`.
- Never auto-accept unknown host keys or globally enable legacy algorithms.
- Do not log SSH stderr without considering that it can contain usernames, hosts, paths, or command details. Doctor output is minimized and paired with remediation hints.
- Hermes protocol changes belong in `hermes.ts` and, for SSE parsing only, `sse.ts`.
- OpenClaw handshake changes belong in `openclaw.ts` and `openclaw-identity.ts`. The v2 claim has one canonical implementation.
- Device identities are generated once, stored with mode `0600`, and reused. Never regenerate them on every connection.
- Do not start a new remote gateway for every connection. Reuse the remote service already running.
- Keep protocol fixtures free of real credentials and real session content.

## Security and data handling

- Redact recursively before returning MCP content. Test both nested objects and arrays.
- Deny access before reading a session, not after filtering its output.
- MCP startup fails closed when enabled without a bearer token.
- Bind listeners to loopback or a trusted Tailscale address, never `0.0.0.0` for convenience.
- Remote approval requests are surfaced to the user and never automatically approved.
- Preserve user configuration and existing remote sessions during tests and smoke checks.
- Temporary files belong under `.tmp` and are removed immediately after use. Never commit credentials, device keys, `.env` files, or local profile copies.

## Tests and verification

Run the narrowest useful test first:

```bash
npx vitest run tests/<name>.test.ts -t "<case>"
```

Before every commit, run:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Before a release or substantial change, run:

```bash
npm run check
```

Tests must cover behavior, not only types:

- Hermes run creation, SSE events, final fallback, cancellation, and approvals.
- OpenClaw challenge/signature handshake over a real WebSocket, RPC failures, and session continuation.
- SSH argument safety and common doctor diagnostics.
- MCP authentication, initialize/list/call, allow-list denial, redaction, read, and watch.
- Job completion, timeout, cancellation, and notification failure boundaries.

A passing mock test does not prove compatibility with a real Hermes or OpenClaw deployment. State that distinction in delivery notes and run `agent_link_doctor` against a real host when one is available.

Real model-backed E2E coverage lives in `e2e/` and `.github/workflows/e2e.yml`. SSH, Tailscale, local, and Headscale jobs must start actual official Hermes/OpenClaw services and complete an initial model task plus a same-session continuation. Never replace these with protocol mocks, skip missing credentials silently, or report a health check as an E2E pass. Read [docs/E2E.md](docs/E2E.md) before changing the infrastructure or required secrets.

## Documentation

Update documentation with behavior changes:

- `README.md`: installation, configuration, model tools, MCP, and release instructions.
- `docs/DESIGN.md`: architectural contracts and protocol ownership.
- `docs/SSH.md`: provider-specific setup and newly observed SSH failures.
- `AGENTS.md`: only durable contributor invariants, not task history.

Use context pointers instead of copying the same protocol rules into several files. Avoid repeating full configuration examples unless they exercise different branches.

## CI and release

- GitHub Actions runs CI on pushes and pull requests.
- Releases are tag-triggered and use `secrets.NPM_TOKEN`; never publish from an agent workstation.
- A tag must exactly match `package.json` after removing the leading `v`.
- The release workflow runs all checks before publishing.
- Publish `@weaxs/dsh-agent-link` first, then stage the same payload as `dsh-agent-link` and rewrite `cordis.patch.yml` to the unscoped package name.
- Verify `dist/index.js`, `cordis.patch.yml`, `icon.svg`, locale resources, README, LICENSE, and docs in the packed artifact.
- Do not commit `dist`, `node_modules`, coverage output, or generated tarballs.

## Commit discipline

- Keep each commit focused and review the complete diff before committing.
- Do not include unrelated formatting, dependency upgrades, or generated files.
- Do not push secrets, user profile changes, or local smoke-test configuration.
- Report test results, build results, remote validation limits, and any remaining protocol assumptions separately.
