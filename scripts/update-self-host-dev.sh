#!/usr/bin/env bash
set -euo pipefail

# Developer self-host updater.
#
# Install the local packed @paperwing-dev/tiller package, then pin the target
# to the sandbox image recorded by the last validation deploy. Local changes
# are allowed except under packages/harness and packages/containers, which
# must match the recorded deploy image commit. Existing workload containers
# are preserved so they can complete the normal Stop workspace-save flow
# before a later Start recreates them.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TILLER_DIR="$REPO_ROOT/packages/tiller"
LOCAL_CONFIG="$REPO_ROOT/.update-self-host-dev.local.env"
DEPLOY_RECORD="$REPO_ROOT/.update-self-host-deploy-record.json"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new)

if [[ -f "$LOCAL_CONFIG" ]]; then
  # shellcheck disable=SC1090
  source "$LOCAL_CONFIG"
fi

SELF_HOST_TARGET_EXPLICIT="${SELF_HOST_TARGET:-${PI:-}}"
SELF_HOST_TARGET_LOCAL="${SELF_HOST_TARGET_LOCAL:-${PI_LOCAL:-}}"
SELF_HOST_TARGET_REMOTE="${SELF_HOST_TARGET_REMOTE:-${PI_REMOTE:-}}"
SELF_HOST_TARGET=""

IMAGE_SHA=""
IMAGE=""
TARGET_PINNED_IMAGE=""
TMP_DIR="$(mktemp -d)"
LOCAL_TILLER_PACKAGE_PATH=""
LOCAL_TILLER_PACKAGE_NAME_FILE="$TMP_DIR/tiller-package-name.txt"
LOCAL_TILLER_BUILD_PID=""

cleanup() {
  [[ -n "$LOCAL_TILLER_BUILD_PID" ]] && kill "$LOCAL_TILLER_BUILD_PID" 2>/dev/null || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

usage() {
  cat <<EOF
Usage:
  npm run update-host:local-env
  bash scripts/update-self-host-dev.sh

Updates only the selected developer self-host target.

Provide a target by either:
  SELF_HOST_TARGET=user@mac-mini.local npm run update-host:local-env
  SELF_HOST_TARGET_LOCAL=user@192.168.8.10 SELF_HOST_TARGET_REMOTE=user@100.64.0.10 npm run update-host:local-env
  PI=user@raspberrypi.local npm run update-host:local-env

Or create a local config file:
  cp scripts/update-self-host-dev.example.env .update-self-host-dev.local.env

Installs the local tiller package and pins the target to the image from the
last validation deploy record. packages/harness and packages/containers must
match that deploy record's imageCommitSha.
EOF
}

probe_self_host_target() {
  local target="$1"
  ssh "${SSH_OPTS[@]}" -o BatchMode=yes -o ConnectTimeout=3 "$target" "true" >/dev/null 2>&1
}

resolve_self_host_target() {
  if [[ -n "$SELF_HOST_TARGET_EXPLICIT" ]]; then
    SELF_HOST_TARGET="$SELF_HOST_TARGET_EXPLICIT"
    return 0
  fi

  if [[ -n "$SELF_HOST_TARGET_LOCAL" && -n "$SELF_HOST_TARGET_REMOTE" ]]; then
    if probe_self_host_target "$SELF_HOST_TARGET_LOCAL"; then
      SELF_HOST_TARGET="$SELF_HOST_TARGET_LOCAL"
      return 0
    fi

    if probe_self_host_target "$SELF_HOST_TARGET_REMOTE"; then
      SELF_HOST_TARGET="$SELF_HOST_TARGET_REMOTE"
      return 0
    fi

    echo "ERROR: neither configured self-host target is reachable." >&2
    echo "Local:  $SELF_HOST_TARGET_LOCAL" >&2
    echo "Remote: $SELF_HOST_TARGET_REMOTE" >&2
    exit 1
  fi

  if [[ -n "$SELF_HOST_TARGET_LOCAL" ]]; then
    SELF_HOST_TARGET="$SELF_HOST_TARGET_LOCAL"
    return 0
  fi

  if [[ -n "$SELF_HOST_TARGET_REMOTE" ]]; then
    SELF_HOST_TARGET="$SELF_HOST_TARGET_REMOTE"
    return 0
  fi

  return 1
}

if [[ "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ $# -gt 0 ]]; then
  echo "This script does not accept positional args." >&2
  usage >&2
  exit 1
fi

resolve_self_host_target || true
if [[ -z "$SELF_HOST_TARGET" ]]; then
  cat >&2 <<EOF
ERROR: no developer self-host target configured.

Set up one of these first:
  1. cp scripts/update-self-host-dev.example.env .update-self-host-dev.local.env
  2. Edit .update-self-host-dev.local.env and set either:
     - SELF_HOST_TARGET=user@mac-mini.local
     - or SELF_HOST_TARGET_LOCAL=user@192.168.8.10 plus SELF_HOST_TARGET_REMOTE=user@100.64.0.10

Or run it once with an inline target:
  SELF_HOST_TARGET=user@mac-mini.local npm run update-host:local-env
EOF
  usage >&2
  exit 1
fi

ssh_target() {
  ssh "${SSH_OPTS[@]}" "$SELF_HOST_TARGET" "$@"
}

scp_target() {
  scp "${SSH_OPTS[@]}" "$@"
}

run_timed() {
  local label="$1"
  shift
  local start=$SECONDS
  local status=0
  if "$@"; then
    status=0
  else
    status=$?
  fi
  echo "$label took $((SECONDS - start))s"
  return "$status"
}

current_target_runner_image() {
  ssh_target "node <<'EOF'
const fs = require('fs');
const path = require('path');
const configPath = path.join(process.env.HOME, '.config', 'tiller', 'config.json');

try {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  process.stdout.write((config.localRunnerImage || '').trim());
} catch {}
EOF"
}

target_has_runner_image() {
  local image_ref="$1"
  ssh_target "docker image inspect '$image_ref' >/dev/null 2>&1"
}

parse_deploy_record() {
  if [[ ! -f "$DEPLOY_RECORD" ]]; then
    echo "ERROR: no validation deploy record found at $DEPLOY_RECORD" >&2
    echo "Run \`npm run deploy:dev\` first." >&2
    exit 1
  fi

  local record
  record="$(node "$REPO_ROOT/scripts/deploy-record.mjs" read "$DEPLOY_RECORD")" || {
    echo "ERROR: failed to parse validation deploy record at $DEPLOY_RECORD" >&2
    exit 1
  }

  local remaining
  remaining="${record#*$'\n'}"
  IMAGE_SHA="${remaining%%$'\n'*}"
  remaining="${remaining#*$'\n'}"
  IMAGE="${remaining%%$'\n'*}"
}

validate_local_runner_inputs_match_deploy() {
  if ! git -C "$REPO_ROOT" rev-parse --verify --quiet "${IMAGE_SHA}^{commit}" >/dev/null; then
    echo "ERROR: deploy record imageCommitSha $IMAGE_SHA is not present locally." >&2
    echo "Fetch origin or rerun \`npm run deploy:dev\` before updating the host." >&2
    exit 1
  fi

  local dirty_inputs
  dirty_inputs="$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all -- packages/harness packages/containers)"
  if [[ -n "$dirty_inputs" ]]; then
    echo "ERROR: local harness/container inputs differ from the validation deploy record." >&2
    echo "$dirty_inputs" >&2
    echo "Commit and deploy those image inputs first, or revert them before update-host:local-env." >&2
    exit 1
  fi

  if ! git -C "$REPO_ROOT" diff --quiet "$IMAGE_SHA" -- packages/harness packages/containers; then
    echo "ERROR: packages/harness or packages/containers differ from deployed commit $IMAGE_SHA." >&2
    echo "Run \`npm run deploy:dev\` for this commit before updating the host." >&2
    exit 1
  fi
}

resolve_local_env_release() {
  parse_deploy_record
  validate_local_runner_inputs_match_deploy
}

start_local_tiller_package_build() {
  if [[ -n "$LOCAL_TILLER_PACKAGE_PATH" || -n "$LOCAL_TILLER_BUILD_PID" ]]; then
    return 0
  fi

  echo "Pre-building local tiller package..."
  (
    cd "$TILLER_DIR"
    npm run build >/dev/null
    npm pack --pack-destination "$TMP_DIR" > "$LOCAL_TILLER_PACKAGE_NAME_FILE"
  ) &
  LOCAL_TILLER_BUILD_PID=$!
}

wait_for_local_tiller_package_build() {
  if [[ -n "$LOCAL_TILLER_PACKAGE_PATH" ]]; then
    return 0
  fi

  if [[ -z "$LOCAL_TILLER_BUILD_PID" ]]; then
    start_local_tiller_package_build
  fi

  if ! wait "$LOCAL_TILLER_BUILD_PID"; then
    echo "ERROR: failed to build the local tiller package." >&2
    exit 1
  fi
  LOCAL_TILLER_BUILD_PID=""

  local package_tgz
  package_tgz="$(tr -d '\r\n' < "$LOCAL_TILLER_PACKAGE_NAME_FILE")"
  if [[ -z "$package_tgz" ]]; then
    echo "ERROR: local tiller packaging did not produce a tarball name." >&2
    exit 1
  fi

  LOCAL_TILLER_PACKAGE_PATH="$TMP_DIR/$package_tgz"
  echo "Local tiller package ready."
}

install_local_tiller_on_target() {
  local remote_package="/tmp/tiller-update-${IMAGE_SHA}.tgz"
  wait_for_local_tiller_package_build

  echo "Copying tiller package to target ($SELF_HOST_TARGET)..."
  scp_target "$LOCAL_TILLER_PACKAGE_PATH" "$SELF_HOST_TARGET:$remote_package"

  echo "Installing tiller from local package on target..."
  ssh_target "sudo -n npm install -g --userconfig \"\$HOME/.npmrc\" '$remote_package' && rm -f '$remote_package'"
}

pull_exact_runner_image_on_target() {
  echo "Pulling exact runner image on target: $IMAGE"
  ssh_target "docker pull '$IMAGE'"
}

sync_target_runner_image() {
  if target_has_runner_image "$IMAGE"; then
    echo "Target already has runner image $IMAGE."
  else
    run_timed "Target image pull" pull_exact_runner_image_on_target
  fi
}

pin_target_host_config() {
  echo "Pinning target host config to $IMAGE"
  ssh_target "node - '$IMAGE' <<'EOF'
const fs = require('fs');
const path = require('path');
const image = process.argv[2];
const configPath = path.join(process.env.HOME, '.config', 'tiller', 'config.json');
let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch {}
config.localRunnerImage = image;
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
EOF"
}

restart_host_service() {
  echo "Restarting tiller-host.service on target..."
  ssh_target "sudo -n systemctl restart tiller-host.service"
}

check_target_stack_health() {
  ssh_target "node <<'EOF'
const fs = require('fs');
const path = require('path');

const configPath = path.join(process.env.HOME, '.config', 'tiller', 'config.json');
let config = {};
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch {}

const localRunnerPort = Number(process.env.TILLER_LOCAL_RUNNER_PORT || config.localRunnerPort || 8789);

const checks = [
  ['runner', 'http://127.0.0.1:' + localRunnerPort + '/healthz', {}],
];

(async () => {
  for (const [label, url, headers] of checks) {
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(2500),
      });
      if (!response.ok) {
        console.error(label + ': ' + url + ' -> ' + response.status);
        process.exit(1);
      }
    } catch (error) {
      console.error(label + ': ' + url + ' -> ' + (error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  }
})().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
EOF"
}

wait_for_target_stack_health() {
  local attempts="${1:-30}"
  local delay_seconds="${2:-2}"
  local last_error=""

  for attempt in $(seq 1 "$attempts"); do
    last_error="$(check_target_stack_health 2>&1)" && return 0

    if [[ -n "$last_error" ]]; then
      echo "Target stack still starting (${attempt}/${attempts}): $last_error"
    else
      echo "Target stack still starting (${attempt}/${attempts})..."
    fi

    sleep "$delay_seconds"
  done

  echo "Target stack did not become healthy after restart." >&2
  if [[ -n "$last_error" ]]; then
    echo "$last_error" >&2
  fi
  return 1
}

print_target_service_logs() {
  echo "Recent tiller-host logs from target..."
  ssh_target "journalctl -u tiller-host -n 80 --no-pager -o short-iso"
}

print_final_status() {
  echo "Checking target status..."
  if ! wait_for_target_stack_health; then
    print_target_service_logs
  fi
  ssh_target "tiller status && printf '\nPinned image: ' && node -e \"const fs=require('fs'); const p=process.env.HOME+'/.config/tiller/config.json'; const c=JSON.parse(fs.readFileSync(p,'utf8')); console.log(c.localRunnerImage || '(unset)');\""
}

echo "Updating developer self-host target only: $SELF_HOST_TARGET"
echo "This installs the local tiller package and pins the target to the last validation deploy image."
resolve_local_env_release
start_local_tiller_package_build

TARGET_PINNED_IMAGE="$(current_target_runner_image)"
echo "Target current pinned image: ${TARGET_PINNED_IMAGE:-(unset)}"
echo "Target image ref: $IMAGE"

sync_target_runner_image

run_timed "Local tiller install on target" install_local_tiller_on_target

pin_target_host_config
echo "Existing tiller workload containers were left unchanged."
echo "They can Stop and save on their current image; their next Start recreates them from the pinned image."
run_timed "Target host restart" restart_host_service
print_final_status
