# Real end-to-end testing

The `Transport Integration Tests` workflow starts the official Hermes and OpenClaw images and executes real model-backed tasks through the plugin. These tests do not use protocol mocks and do not treat a successful gateway startup as a passing test.

## Jobs

| Job                               | Actual network path                                                   | Additional infrastructure                                      |
| --------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------- |
| `Local / Hermes and OpenClaw`     | Plugin → loopback-published gateway port                              | Official agent containers                                      |
| `SSH / Hermes and OpenClaw`       | Plugin → system OpenSSH `ssh -W` → SSH container → gateway            | `linuxserver/openssh-server`, ephemeral ED25519 key            |
| `Tailscale / Hermes and OpenClaw` | Plugin → runner tailnet → sidecar tailnet IP → gateway                | Tailscale runner action and two Tailscale sidecars             |
| `Headscale / Hermes and OpenClaw` | Plugin → self-hosted Headscale tailnet → sidecar tailnet IP → gateway | Headscale control plane inside the job, two Tailscale sidecars |

Every job tests **both Hermes and OpenClaw independently**:

1. Check protocol health.
2. Start a task that asks the model to remember and return a random token.
3. Require a completed result containing that token.
4. Continue the same remote session and ask the model to repeat it.
5. Require the second result to contain the same token.

The second response verifies a real model invocation and remote session continuity. A manual `workflow_dispatch` without required credentials fails explicitly. Push and scheduled runs emit a visible warning and skip only the missing E2E jobs; they never substitute mocks or report skipped jobs as passing.

## Required secrets

Configure these repository or organization Actions secrets:

| Secret              | Used for                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPENAI_BASE_URL`   | OpenAI-compatible model API base URL, normally ending in `/v1`                                                                                   |
| `OPENAI_API_KEY`    | Credential for that model API                                                                                                                    |
| `OPENAI_MODEL_NAME` | Exact model ID used by both agents                                                                                                               |
| `TAILSCALE_AUTHKEY` | **Reusable** Tailscale pre-auth key (`tskey-auth-...`, not an API/OAuth key) for the runner and two sidecars; required only by the Tailscale job |

Headscale needs no external account or secret. The job creates its own user and pre-auth keys.

`HERMES_API_KEY` and `OPENCLAW_GATEWAY_TOKEN` in the workflow are fixed **ephemeral test gateway passwords**, not production credentials. They exist only inside the short-lived CI environment. Change them in `.github/workflows/e2e.yml` if your policy requires random values.

## Model configuration

Hermes receives:

- `OPENAI_BASE_URL`
- `OPENAI_API_KEY`
- a generated `config.yaml` with `model.provider: custom`, `model.default`, `base_url`, and `key_env: OPENAI_API_KEY`
- `API_SERVER_ENABLED=true`
- `API_SERVER_KEY=$HERMES_API_KEY`

OpenClaw receives a generated `openclaw.json` using `models.providers.openai` with `openai-completions`, a text-only model entry, and `agents.defaults.model.primary = openai/<model>`. No tools are enabled for the test task.

If `OPENAI_BASE_URL` points to `127.0.0.1` or `localhost`, the generated container configuration rewrites the host to `host.docker.internal`. On Linux, Compose maps that name through `host-gateway`.

## OpenClaw device approval

- Local and SSH-forwarded connections use OpenClaw's trusted loopback auto-approval behavior.
- Tailscale and Headscale are remote connections. A sidecar watches `openclaw devices list --json` and calls `openclaw devices approve <requestId>` for new test devices.

This is real OpenClaw pairing, not a bypass in the plugin. Each test run persists its own Ed25519 device identity for that gateway connection.

## Running the workflow

Run **Transport Integration Tests** manually through `workflow_dispatch`, or let it run when E2E-related files change on `main` or on its weekly schedule. The normal `CI` workflow separately runs Biome, TypeScript, unit/protocol tests, build, and package checks without model credentials.

To run one transport locally with Docker and the same credentials:

```bash
export OPENAI_BASE_URL='https://your-endpoint.example/v1'
export OPENAI_API_KEY='...'
export OPENAI_MODEL_NAME='your-model'
bash .github/e2e/scripts/run-compose.sh local
```

For the Tailscale mode, also export `TAILSCALE_AUTHKEY` and connect the local machine to the same tailnet first. The Headscale script starts its own control plane and joins the local machine to it. Docker is required for all four modes; installing Hermes or OpenClaw on the host is not.

## Logs and cleanup

Each script uses a unique Compose project and removes containers, networks, and volumes on exit. On failure, the workflow uploads container logs as artifacts. Logs should not contain model credentials, but hostnames, device IDs, session IDs, and model output are expected test data.

Model calls cost money and can take several minutes. The job timeout is 35 minutes; each adapter task has its own timeout as well.
