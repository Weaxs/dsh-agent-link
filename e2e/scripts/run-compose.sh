#!/usr/bin/env bash
set -euo pipefail

mode="${1:?usage: run-compose.sh local|ssh|tailscale|headscale}"
case "$mode" in local|ssh|tailscale|headscale) ;; *) echo "unknown mode $mode" >&2; exit 2 ;; esac

root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
mkdir -p e2e/generated
project="agent-link-e2e-$mode"
files=(-f e2e/compose.yml -f "e2e/compose.$mode.yml")
compose=(docker compose -p "$project" "${files[@]}")

cleanup() {
  status=$?
  set +e
  "${compose[@]}" logs --no-color > "e2e/generated/e2e-$mode.log" 2>&1
  "${compose[@]}" down -v --remove-orphans >> "e2e/generated/e2e-$mode.log" 2>&1
  if [[ "$mode" == headscale && -n "${TS_SOCKET:-}" ]]; then
    sudo tailscale --socket="$TS_SOCKET" down >/dev/null 2>&1
    sudo pkill -f 'tailscaled.*headscale-e2e.state' >/dev/null 2>&1
  fi
  exit "$status"
}
trap cleanup EXIT

: "${HERMES_API_KEY:=e2e-hermes-gateway-token}"
: "${OPENCLAW_GATEWAY_TOKEN:=e2e-openclaw-gateway-token}"
export HERMES_API_KEY OPENCLAW_GATEWAY_TOKEN
export E2E_CONTAINER_OPENAI_BASE_URL="$(node -e "process.stdout.write(process.env.OPENAI_BASE_URL.replace(/^(https?:\\/\\/)(?:127\\.0\\.0\\.1|localhost)(?=[:/]|$)/,'\$1host.docker.internal'))")"

npm run build
node e2e/scripts/write-config.mjs
"${compose[@]}" config --quiet

case "$mode" in
  local)
    export E2E_TRANSPORT=local E2E_MODE_LABEL=local HERMES_PORT=18642 OPENCLAW_PORT=18789
    ;;
  ssh)
    export E2E_TRANSPORT=ssh E2E_MODE_LABEL=ssh HERMES_PORT=8642 OPENCLAW_PORT=18789
    ssh-keygen -q -t ed25519 -N '' -f e2e/generated/id_ed25519
    chmod 600 e2e/generated/id_ed25519
    export E2E_SSH_PUBLIC_KEY="$(cat e2e/generated/id_ed25519.pub)"
    cat > e2e/generated/ssh_config <<'EOF'
Host hermes-e2e
  HostName 127.0.0.1
  Port 22022
  User agent
  IdentityFile e2e/generated/id_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null

Host openclaw-e2e
  HostName 127.0.0.1
  Port 22023
  User agent
  IdentityFile e2e/generated/id_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking no
  UserKnownHostsFile /dev/null
EOF
    export E2E_SSH_CONFIG="$root/e2e/generated/ssh_config"
    ;;
  tailscale)
    if [[ -z "${TAILSCALE_AUTHKEY:-}" ]]; then
      echo 'TAILSCALE_AUTHKEY is required for the real Tailscale E2E job' >&2
      exit 1
    fi
    export E2E_TRANSPORT=direct E2E_MODE_LABEL=tailscale HERMES_PORT=8642 OPENCLAW_PORT=18789
    ;;
  headscale)
    export E2E_TRANSPORT=direct E2E_MODE_LABEL=headscale HERMES_PORT=8642 OPENCLAW_PORT=18789
    "${compose[@]}" up -d headscale
    for _ in {1..60}; do
      if "${compose[@]}" exec -T headscale headscale users list >/dev/null 2>&1; then break; fi
      sleep 2
    done
    "${compose[@]}" exec -T headscale headscale users create e2e || true
    key_json="$("${compose[@]}" exec -T headscale headscale preauthkeys create --user 1 --reusable --expiration 10m -o json)"
    export HEADSCALE_AUTHKEY="$(node -e "const s=process.argv[1];try{const j=JSON.parse(s);process.stdout.write(j.key??j.preAuthKey??j.authKey??s.trim())}catch{process.stdout.write(s.trim())}" "$key_json")"
    if [[ -z "$HEADSCALE_AUTHKEY" ]]; then echo 'Could not create a Headscale preauth key' >&2; exit 1; fi
    if ! command -v tailscaled >/dev/null; then
      curl -fsSL https://tailscale.com/install.sh | sudo sh
    fi
    export TS_SOCKET="${RUNNER_TEMP:-/tmp}/headscale-e2e.sock"
    export E2E_TAILSCALE_SUDO=1
    sudo tailscaled --state="${RUNNER_TEMP:-/tmp}/headscale-e2e.state" --socket="$TS_SOCKET" >"${RUNNER_TEMP:-/tmp}/headscale-e2e.log" 2>&1 &
    for _ in {1..30}; do
      if sudo tailscale --socket="$TS_SOCKET" status >/dev/null 2>&1; then break; fi
      sleep 1
    done
    sudo tailscale --socket="$TS_SOCKET" up --login-server=http://127.0.0.1:28080 --authkey="$HEADSCALE_AUTHKEY" --hostname=runner-e2e --accept-dns=true --reset
    ;;
esac

"${compose[@]}" up -d --wait

if [[ "$mode" == tailscale || "$mode" == headscale ]]; then
  connected=false
  for _ in {1..45}; do
    if eval "$(node e2e/scripts/tailscale-env.mjs)"; then connected=true; break; fi
    sleep 2
  done
  if [[ "$connected" != true ]]; then echo 'Tailscale peers did not become available' >&2; exit 1; fi
fi

node e2e/run.mjs
