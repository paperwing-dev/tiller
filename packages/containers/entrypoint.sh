#!/bin/bash
set -e
# Keep runtime crash artifacts out of the persisted workspace.
ulimit -S -c 0 2>/dev/null || true

LAST_PROGRESS_MESSAGE=""
LAST_PROGRESS_STEP_ID=""
RUNNER_STOP_REPORTED=0
HARNESS_LAUNCHED=false
PRE_HARNESS_STARTUP_FAILURE_EXIT_CODE=76

verify_host_command_fence() {
  if [ "${TILLER_HOST_COMMAND_FENCE_REQUIRED:-}" != "1" ]; then
    return 0
  fi

  local generation="${TILLER_HOST_COMMAND_GENERATION:-}"
  local fence_dir="${TILLER_HOST_COMMAND_FENCE_PATH:-/run/tiller-host-command}"
  case "$generation" in
    ''|*[!0-9]*|0)
      echo "[boot] Refusing fenced host launch with invalid command generation"
      return 1
      ;;
  esac
  if [ ! -f "${fence_dir}/running-${generation}" ]; then
    echo "[boot] Refusing superseded host launch for command generation ${generation}"
    return 1
  fi
}

add_cf_access_headers() {
  local -n target_ref="$1"
  if [ -n "$CF_ACCESS_CLIENT_ID" ] && [ -n "$CF_ACCESS_CLIENT_SECRET" ]; then
    target_ref+=(
      -H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}"
      -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}"
    )
  fi
  if [ -n "${TILLER_RUNTIME_CAPABILITY:-}" ]; then
    target_ref+=(-H "X-Tiller-Capability: ${TILLER_RUNTIME_CAPABILITY}")
  fi
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' '
}

json_string_or_null() {
  local value="$1"
  if [ -n "$value" ]; then
    printf '"%s"' "$(json_escape "$value")"
  else
    printf 'null'
  fi
}

escape_bash_glob_literal() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\*/\\*}"
  value="${value//\?/\\?}"
  value="${value//\[/\\[}"
  value="${value//\]/\\]}"
  printf '%s' "$value"
}

redact_env_names_values() {
  local text="$1"
  local names_csv="$2"
  local min_length="${3:-4}"
  local old_ifs="$IFS"
  local name=""
  local value=""
  local pattern=""

  IFS=','
  for name in $names_csv; do
    IFS="$old_ifs"
    [ -n "$name" ] || continue
    value="${!name-}"
    if [ -n "$value" ] && [ "${#value}" -ge "$min_length" ]; then
      pattern="$(escape_bash_glob_literal "$value")"
      text="${text//$pattern/[redacted]}"
    fi
    IFS=','
  done
  IFS="$old_ifs"
  printf '%s' "$text"
}

redact_managed_env_values() {
  local text="$1"
  text="$(redact_env_names_values "$text" "${TILLER_SESSION_ENV_NAMES:-}" 1)"
  redact_env_names_values "$text" "${TILLER_MANAGED_ENV_NAMES:-}" 4
}

directory_has_files() {
  local dir="$1"
  [ -d "$dir" ] || return 1
  find "$dir" -mindepth 1 -print -quit 2>/dev/null | grep -q .
}

use_claude_subscription_auth() {
  [ "$HARNESS" = "claude-code" ] && [ "$TILLER_CLAUDE_AUTH_RESOLVED_MODE" = "subscription" ]
}

clear_claude_api_auth_env() {
  unset ANTHROPIC_API_KEY
  unset ANTHROPIC_AUTH_TOKEN
  unset ANTHROPIC_BASE_URL
  unset ANTHROPIC_CUSTOM_HEADERS
}

post_startup_diagnostics() {
  local payload="$1"
  local attempts="${2:-1}"
  local delay_seconds="${3:-0.5}"
  if [ -z "${HUB_URL:-}" ] || [ -z "${REPO_SLUG:-}" ] || [ -z "${TILLER_LIFECYCLE_START_OP_ID:-}" ]; then
    return 1
  fi

  local http_code="curl_error"
  local attempt
  for attempt in $(seq 1 "$attempts"); do
    local curl_args=(
      -s -o /dev/null -w '%{http_code}' -X POST
      "${HUB_URL}/api/envs/${REPO_SLUG}/startup-diagnostics"
      -H "Content-Type: application/json"
      -H "X-Tiller-Lifecycle-Op-Id: ${TILLER_LIFECYCLE_START_OP_ID}"
      --data-raw "$payload"
      --max-time 2
    )
    add_cf_access_headers curl_args
    http_code=$(curl "${curl_args[@]}" 2>/dev/null) || http_code="curl_error"
    if [ "$http_code" = "200" ]; then
      return 0
    fi
    if [ "$attempt" -lt "$attempts" ]; then
      sleep "$delay_seconds"
    fi
  done

  echo "[boot] startup diagnostics report failed (HTTP ${http_code})"
  return 1
}

report_progress() {
  local step_id="$1"
  local msg
  msg="$(redact_managed_env_values "$2")"
  local severity="${3:-info}"
  local detail
  detail="$(redact_managed_env_values "${4:-}")"
  LAST_PROGRESS_STEP_ID="$step_id"
  LAST_PROGRESS_MESSAGE="$msg"
  echo "[boot][${step_id}] ${msg}"

  local payload
  payload=$(printf '{"type":"event","stepId":"%s","severity":"%s","message":"%s","detail":%s}' \
    "$(json_escape "$step_id")" \
    "$(json_escape "$severity")" \
    "$(json_escape "$msg")" \
    "$(json_string_or_null "$detail")")
  post_startup_diagnostics "$payload" 1 || true
}

build_startup_log_tails_json() {
  local harness_tail=""
  local stop_control_tail=""
  local bootstrap_tail=""

  harness_tail="$(summarize_recent_output "$TILLER_LOG")"
  stop_control_tail="$(summarize_recent_output "$STOP_CONTROL_LOG")"
  bootstrap_tail="$(summarize_recent_output "$BOOTSTRAP_LOG")"

  printf '{"harness":%s,"stopControl":%s,"bootstrap":%s}' \
    "$(json_string_or_null "$harness_tail")" \
    "$(json_string_or_null "$stop_control_tail")" \
    "$(json_string_or_null "$bootstrap_tail")"
}

report_startup_failure_and_exit() {
  local step_id="$1"
  local message
  message="$(redact_managed_env_values "$2")"
  local detail
  detail="$(redact_managed_env_values "${3:-}")"
  local exit_code="${4:-}"
  local signal_name="${5:-}"

  LAST_PROGRESS_STEP_ID="${step_id}"
  LAST_PROGRESS_MESSAGE="${message}"
  echo "[boot][${step_id}] ERROR: ${message}" >&2

  local log_tails_json
  log_tails_json="$(build_startup_log_tails_json)"
  local exit_code_json="null"
  if [ -n "$exit_code" ]; then
    exit_code_json="$exit_code"
  fi
  local signal_json
  signal_json="$(json_string_or_null "$signal_name")"
  local payload
  payload=$(printf '{"type":"failure","stepId":"%s","message":"%s","detail":%s,"exitCode":%s,"signal":%s,"logTails":%s}' \
    "$(json_escape "$step_id")" \
    "$(json_escape "$message")" \
    "$(json_string_or_null "$detail")" \
    "$exit_code_json" \
    "$signal_json" \
    "$log_tails_json")

  echo "[boot] final startup diagnostics: ${payload}" >&2
  post_startup_diagnostics "$payload" 3 0.5 || true
  RUNNER_STOP_REPORTED=1
  if [ "${RUNNER_BACKEND:-}" = "host" ] && [ "$HARNESS_LAUNCHED" != "true" ]; then
    # The machine runner recognizes this exact exit code together with the
    # immutable Start operation/generation labels. It proves the harness never
    # ran, so a later Start may safely remove this stopped container.
    exit "$PRE_HARNESS_STARTUP_FAILURE_EXIT_CODE"
  fi
  exit 1
}

request_durable_stop() {
  local reason="$1"
  if [ -z "${HUB_URL:-}" ] || [ -z "${REPO_SLUG:-}" ]; then
    echo "[boot] Cannot request durable stop (${reason}): HUB_URL or REPO_SLUG missing"
    return 1
  fi

  local response_file="/tmp/tiller-stop-request-response"
  rm -f "$response_file"

  local curl_args=(
    -s
    -o "$response_file"
    -w '%{http_code}'
    -X POST
    "${HUB_URL}/api/envs/${REPO_SLUG}/stop"
    --max-time 15
  )
  add_cf_access_headers curl_args

  local http_code
  http_code=$(curl "${curl_args[@]}" 2>/dev/null) || http_code="curl_error"
  local response_body=""
  if [ -f "$response_file" ]; then
    response_body="$(cat "$response_file" 2>/dev/null || true)"
    rm -f "$response_file"
  fi

  if [ "$http_code" = "200" ]; then
    echo "[boot] Durable stop requested: ${reason}"
    return 0
  fi

  if [ "$http_code" = "409" ]; then
    if printf '%s' "$response_body" | grep -qiE 'saving changes|not currently running'; then
      echo "[boot] Durable stop already in progress: ${reason}"
      return 0
    fi
  fi

  echo "[boot] Durable stop request failed (${reason}): HTTP ${http_code} ${response_body}"
  return 1
}

wait_for_durable_stop_or_exit() {
  local reason="$1"
  if request_durable_stop "$reason"; then
    report_progress "stop-control" "Saving workspace…"
    wait
    return 0
  fi

  echo "[boot] durable stop request failed after lead exit: ${reason}" >&2
  exit 1
}

report_harness_failure() {
  local message
  message="$(redact_managed_env_values "$1")"
  if [ -z "${HUB_URL:-}" ] || [ -z "${REPO_SLUG:-}" ]; then
    echo "[boot] Cannot report harness failure: HUB_URL or REPO_SLUG missing"
    return 1
  fi

  local curl_args=(
    -s -o /dev/null -w '%{http_code}' -X POST
    "${HUB_URL}/api/envs/${REPO_SLUG}/harness-failed"
    -H "Content-Type: text/plain"
    --data-raw "$message"
    --max-time 10
  )
  add_cf_access_headers curl_args
  if [ -n "${TILLER_LIFECYCLE_START_OP_ID:-}" ]; then
    curl_args+=(-H "X-Tiller-Lifecycle-Op-Id: ${TILLER_LIFECYCLE_START_OP_ID}")
  fi

  local http_code
  http_code=$(curl "${curl_args[@]}" 2>/dev/null) || http_code="curl_error"
  if [ "$http_code" = "200" ]; then
    echo "[boot] Harness failure reported to hub"
    return 0
  fi
  echo "[boot] Harness failure report failed (HTTP ${http_code})"
  return 1
}

report_runner_infra_ready() {
  if [ "${RUNNER_BACKEND:-}" != "host" ]; then
    return 0
  fi
  if [ -z "${HUB_URL:-}" ] || [ -z "${REPO_SLUG:-}" ]; then
    echo "[boot] Cannot report infra ready: HUB_URL or REPO_SLUG missing"
    return 1
  fi

  local curl_args=(
    -s -o /dev/null -w '%{http_code}' -X POST
    "${HUB_URL}/api/envs/${REPO_SLUG}/infra-ready"
    --max-time 10
  )
  add_cf_access_headers curl_args
  if [ -n "${TILLER_LIFECYCLE_START_OP_ID:-}" ]; then
    curl_args+=(-H "X-Tiller-Lifecycle-Op-Id: ${TILLER_LIFECYCLE_START_OP_ID}")
  fi

  local http_code
  http_code=$(curl "${curl_args[@]}" 2>/dev/null) || http_code="curl_error"
  if [ "$http_code" = "200" ]; then
    echo "[boot] Runner infra-ready reported to hub"
    return 0
  fi
  echo "[boot] Runner infra-ready report failed (HTTP ${http_code})"
  return 1
}

resolve_stop_lifecycle_op_id() {
  if [ -s "${STOP_OP_ID_PATH:-/tmp/tiller-lifecycle-stop-op-id}" ]; then
    cat "${STOP_OP_ID_PATH}" 2>/dev/null || true
  fi
}

report_runner_stopped() {
  local message
  message="$(redact_managed_env_values "$1")"
  local explicit_op_id="${2:-}"
  case "${RUNNER_BACKEND:-}" in
    host|cf) ;;
    *) return 0 ;;
  esac
  RUNNER_STOP_REPORTED=1
  if [ -z "${HUB_URL:-}" ] || [ -z "${REPO_SLUG:-}" ]; then
    echo "[boot] Cannot report runner stop: HUB_URL or REPO_SLUG missing"
    return 1
  fi

  local curl_args=(
    -s -o /dev/null -w '%{http_code}' -X POST
    "${HUB_URL}/api/envs/${REPO_SLUG}/runner-stopped"
    -H "Content-Type: text/plain"
    --data-raw "$message"
    --max-time 10
  )
  add_cf_access_headers curl_args
  local resolved_op_id="$explicit_op_id"
  if [ -z "$resolved_op_id" ]; then
    if [ -f "$STOP_REQUESTED_FLAG_PATH" ]; then
      resolved_op_id="$(resolve_stop_lifecycle_op_id)"
    else
      resolved_op_id="${TILLER_LIFECYCLE_START_OP_ID:-}"
    fi
  fi
  if [ -n "$resolved_op_id" ]; then
    curl_args+=(-H "X-Tiller-Lifecycle-Op-Id: ${resolved_op_id}")
  fi

  echo "[boot] Reporting runner stop to hub (op_id=${resolved_op_id:-none}; message=${message})"

  local http_code
  http_code=$(curl "${curl_args[@]}" 2>/dev/null) || http_code="curl_error"
  if [ "$http_code" = "200" ]; then
    echo "[boot] Runner stop reported to hub"
    return 0
  fi
  echo "[boot] Runner stop report failed (HTTP ${http_code})"
  return 1
}

summarize_recent_output() {
  local file_path="$1"
  if [ ! -s "$file_path" ]; then
    return 0
  fi

  local summary=""
  summary="$(tail -20 "$file_path" 2>/dev/null \
    | tr '\n' ' ' \
    | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//' \
    | cut -c 1-300)"
  redact_managed_env_values "$summary"
}

build_runner_stopped_message() {
  local exit_code="$1"
  local message="container exited with code ${exit_code}"
  if [ -n "${LAST_PROGRESS_MESSAGE:-}" ]; then
    message="${message}; last boot step: ${LAST_PROGRESS_MESSAGE}"
  fi

  local harness_excerpt=""
  harness_excerpt="$(summarize_recent_output "$TILLER_LOG")"
  if [ -n "$harness_excerpt" ]; then
    message="${message}; recent harness output: ${harness_excerpt}"
  fi

  printf '%s' "$message"
}

build_stop_cleanup_message() {
  local signal_exit_code="$1"
  local stop_finalize_rc="$2"
  printf 'container exited after stop cleanup (signal exit %s; stop finalize rc %s)' \
    "$signal_exit_code" "$stop_finalize_rc"
}

build_unexpected_cf_cleanup_message() {
  local signal_exit_code="$1"
  local workspace_sync_rc="$2"
  printf 'Cloudflare container stopped outside the lifecycle Stop path (signal exit %s; emergency workspace sync rc %s)' \
    "$signal_exit_code" "$workspace_sync_rc"
}

build_harness_failure_message() {
  local exit_code="$1"
  local message="tiller-harness exited with code ${exit_code}"
  if [ -n "${LAST_PROGRESS_MESSAGE:-}" ]; then
    message="${message}; last boot step: ${LAST_PROGRESS_MESSAGE}"
  fi

  local harness_excerpt=""
  harness_excerpt="$(summarize_recent_output "$TILLER_LOG")"
  if [ -n "$harness_excerpt" ]; then
    message="${message}; recent harness output: ${harness_excerpt}"
  fi

  printf '%s' "$message"
}

resolve_baked_tiller_harness_version() {
  local version_path="${TILLER_BAKED_HARNESS_VERSION_PATH:-/etc/tiller-harness-version}"
  if [ ! -s "$version_path" ]; then
    return 1
  fi

  tr -d '\r\n' < "$version_path"
}

report_baked_tiller_harness() {
  local baked_tiller_harness_version=""
  baked_tiller_harness_version="$(resolve_baked_tiller_harness_version || true)"
  if [ -n "$baked_tiller_harness_version" ]; then
    report_progress "prereq-check" "Using baked tiller-harness $baked_tiller_harness_version"
    return 0
  fi

  report_progress "prereq-check" "Using baked tiller-harness"
}

if ! verify_host_command_fence; then
  # A newer Stop or Destroy removed this generation's token before a delayed
  # docker run reached the entrypoint. Exit without touching the workspace or
  # launching an agent; the host reconciler removes the inert container.
  # The machine runner recognizes this exact exit code together with the container's
  # command-generation label as proof that no workspace effect began.
  exit 75
fi

# --- Git auth for private repos ---
configure_github_credential_helper_for_file() {
  local config_file="$1"
  git config --file "$config_file" credential.https://github.com.helper /usr/local/bin/git-credential-tiller
  git config --file "$config_file" credential.https://github.com.useHttpPath true
}

configure_github_credential_helper() {
  if [ -z "${TILLER_GITHUB_BRIDGE_ID:-}" ] || [ -z "${TILLER_GITHUB_BRIDGE_SECRET:-}" ] || [ -z "${TILLER_GITHUB_ALLOWED_REPO:-}" ]; then
    return 0
  fi

  configure_github_credential_helper_for_file /root/.gitconfig
  if id tiller >/dev/null 2>&1; then
    touch /home/tiller/.gitconfig
    chown tiller:tiller /home/tiller/.gitconfig
    configure_github_credential_helper_for_file /home/tiller/.gitconfig
    chown tiller:tiller /home/tiller/.gitconfig
  fi
}

materialize_plan_writer_checkout() {
  local workspace_dir="${TILLER_PLAN_WRITER_CHECKOUT_DIR:-/workspace}"
  local git_config_path="/run/tiller-plan-writer-gitconfig"
  if [ -z "${TILLER_GITHUB_BASE_COMMIT_SHA:-}" ] || [ -z "${REPO_URL:-}" ]; then
    echo "[boot] Plan writer requires REPO_URL and TILLER_GITHUB_BASE_COMMIT_SHA" >&2
    return 1
  fi
  mkdir -p "$workspace_dir"
  # Docker may pre-create /workspace with the runtime UID. Git refuses to use
  # a worktree owned by another user, so establish the checkout owner before
  # the first repository command rather than only after checkout.
  chown root:root "$workspace_dir"
  find "$workspace_dir" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + 2>/dev/null || true
  rm -f "$git_config_path"
  git config --file "$git_config_path" --add safe.directory "$workspace_dir"
  chmod 0444 "$git_config_path"
  export GIT_CONFIG_GLOBAL="$git_config_path"
  git -C "$workspace_dir" init -q
  git -C "$workspace_dir" remote add origin "$REPO_URL"
  if [ -n "${TILLER_GITHUB_BRIDGE_ID:-}" ] && [ -n "${TILLER_GITHUB_BRIDGE_SECRET:-}" ] && [ -n "${TILLER_GITHUB_ALLOWED_REPO:-}" ]; then
    configure_github_credential_helper_for_file "$workspace_dir/.git/config"
  fi
  git -C "$workspace_dir" fetch --depth 1 origin "$TILLER_GITHUB_BASE_COMMIT_SHA"
  git -C "$workspace_dir" checkout -q --detach FETCH_HEAD
  printf '%s\n' 'External read denied: the requested path is outside the managed checkout.' \
    > "$workspace_dir/.git/tiller-opencode-read-denied"
  chown -R root:root "$workspace_dir"
  find "$workspace_dir" -type d -exec chmod 0555 {} +
  find "$workspace_dir" -type f -exec chmod 0444 {} +
}

report_plan_writer_bootstrap_failure() {
  local exit_code="$?"
  trap - ERR
  if [ -n "${TILLER_PLAN_WRITER_CALLBACK_BASE:-}" ] && [ -n "${TILLER_PLAN_WRITER_TOKEN:-}" ]; then
    local curl_args=(
      -sS -o /dev/null -X POST
      "${TILLER_PLAN_WRITER_CALLBACK_BASE%/}/stop"
      -H "Content-Type: application/json"
      -H "X-Tiller-Plan-Writer-Token: ${TILLER_PLAN_WRITER_TOKEN}"
      --data-raw '{"reason":"runtime_ended","startupError":"Plan Writer checkout bootstrap failed before supervisor startup."}'
      --max-time 15
    )
    add_cf_access_headers curl_args
    curl "${curl_args[@]}" || true
  fi
  exit "$exit_code"
}

if [ "${TILLER_BOOTSTRAP_MODE:-}" = "plan-writer" ]; then
  echo "[boot] Starting isolated Plan Writer native TUI adapter..."
  trap report_plan_writer_bootstrap_failure ERR
  materialize_plan_writer_checkout
  unset TILLER_GITHUB_BRIDGE_ID TILLER_GITHUB_BRIDGE_SECRET TILLER_GITHUB_ALLOWED_REPO REPO_URL
  unset TILLER_MCP_SERVERS_JSON GH_TOKEN GITHUB_TOKEN
  exec tiller-plan-writer
fi

configure_github_credential_helper

if [ "${TILLER_BOOTSTRAP_MODE:-}" = "github-env-publish" ]; then
  echo "[boot] Running GitHub env publish job..."
  exec node /github-env-publish.mjs
fi

if [ "${TILLER_BOOTSTRAP_MODE:-}" = "env-review-run" ]; then
  export TILLER_ENV_REVIEW_BOOTSTRAP=1
  TILLER_BOOTSTRAP_MODE="planner-run"
fi

if [ "${TILLER_BOOTSTRAP_MODE:-}" = "planner-run" ]; then
  IMAGE_REVIEWER_ISOLATION_PROTOCOL="$(cat /etc/tiller-reviewer-isolation-protocol 2>/dev/null || true)"
  if [ "$IMAGE_REVIEWER_ISOLATION_PROTOCOL" != "1" ]; then
    echo "ERROR: This image is not enabled for protected reviewer isolation. Update to a validated image." >&2
    exit 78
  fi
  if [ "${TILLER_REVIEWER_ISOLATION_PROTOCOL:-}" != "$IMAGE_REVIEWER_ISOLATION_PROTOCOL" ]; then
    echo "ERROR: Reviewer isolation protocol request does not match the image capability." >&2
    exit 78
  fi
  if [ "${TILLER_ENV_REVIEW_BOOTSTRAP:-}" = "1" ]; then
    echo "[boot] Running env review run..."
  else
    echo "[boot] Running one-shot reviewer run..."
  fi
  if [ "${TILLER_HARNESS:-}" = "opencode" ]; then
    # One-shot containers exec before the interactive OpenCode block below, so
    # seed the generic OpenCode data/cache/state directories here too.
    PLANNER_OPENCODE_LOCAL_DIR="/home/tiller/.local"
    OPENCODE_DATA_DIR="/home/tiller/.local/share/opencode"
    OPENCODE_CACHE_DIR="/home/tiller/.cache/opencode"
    OPENCODE_RUNTIME_STATE_DIR="/home/tiller/.local/state/opencode"
    OPENCODE_SEED_DIR="/opt/opencode-seed"
    mkdir -p "$OPENCODE_DATA_DIR" "$OPENCODE_CACHE_DIR" "$OPENCODE_RUNTIME_STATE_DIR"
    if ! directory_has_files "$OPENCODE_DATA_DIR" && directory_has_files "$OPENCODE_SEED_DIR/data"; then
      cp -R "$OPENCODE_SEED_DIR/data"/. "$OPENCODE_DATA_DIR"/
    fi
    if ! directory_has_files "$OPENCODE_CACHE_DIR" && directory_has_files "$OPENCODE_SEED_DIR/cache"; then
      cp -R "$OPENCODE_SEED_DIR/cache"/. "$OPENCODE_CACHE_DIR"/
    fi
    if ! directory_has_files "$OPENCODE_RUNTIME_STATE_DIR" && directory_has_files "$OPENCODE_SEED_DIR/state"; then
      cp -R "$OPENCODE_SEED_DIR/state"/. "$OPENCODE_RUNTIME_STATE_DIR"/
    fi
    chown -R tiller:tiller "$PLANNER_OPENCODE_LOCAL_DIR"
    chown -R tiller:tiller "/home/tiller/.cache"
  fi
  # The reviewer supervisor must retain root only long enough to materialize
  # and protect the checkout. It drops every provider child to `tiller`.
  exec tiller-planner
fi

sync_down() {
  echo "Syncing workspace DO → /workspace..."
  node /workspace-sync.mjs down
}

sync_up() {
  echo "Syncing /workspace → workspace DO..."
  flock -w 120 "${TILLER_WORKSPACE_SYNC_LOCK_PATH:-/run/tiller/workspace-sync.lock}" \
    node /workspace-sync.mjs up
}

sync_up_with_retry() {
  local attempt=1 sync_rc=0 retry_delay=0
  while [ "$attempt" -le 4 ]; do
    if sync_up; then return 0; else sync_rc=$?; fi
    if [ "$attempt" -ge 4 ]; then break; fi
    retry_delay=$((2 ** attempt))
    echo "[tiller] workspace save failed (exit ${sync_rc}); retrying in ${retry_delay}s"
    sleep "$retry_delay"
    attempt=$((attempt + 1))
  done
  return "$sync_rc"
}

preflight_workspace_sync_lock() {
  local lock_path="${TILLER_WORKSPACE_SYNC_LOCK_PATH:-/run/tiller/workspace-sync.lock}"
  local lock_dir
  lock_dir="$(dirname "$lock_path")"
  install -d -o tiller -g tiller -m 0770 "$lock_dir" || return 1
  install -o tiller -g tiller -m 0660 /dev/null "$lock_path" || return 1
  flock -n "$lock_path" true || return 1
  runuser -u tiller -- flock -n "$lock_path" true || return 1
}

initialize_startup_deadline() {
  case "${TILLER_STARTUP_DEADLINE_AT_MS:-}" in
    ''|*[!0-9]*)
      export TILLER_STARTUP_DEADLINE_AT_MS="$(( $(node -e 'process.stdout.write(String(Date.now()))') + ${TILLER_STARTUP_TIMEOUT_SECONDS:-180} * 1000 ))"
      ;;
  esac
}

remaining_startup_seconds() {
  local remaining_ms=$((TILLER_STARTUP_DEADLINE_AT_MS - $(node -e 'process.stdout.write(String(Date.now()))')))
  [ "$remaining_ms" -gt 0 ] || return 1
  printf '%s\n' "$(((remaining_ms + 999) / 1000))"
}

materialize_github_base() {
  if [ -z "${TILLER_GITHUB_BASE_COMMIT_SHA:-}" ]; then
    return 0
  fi
  if [ -z "${REPO_URL:-}" ]; then
    echo "[boot] GitHub base checkout requires REPO_URL" >&2
    return 1
  fi

  local workspace_dir="${TILLER_WORKSPACE_SYNC_WORKSPACE:-/workspace}"
  if ! mkdir -p "$workspace_dir"; then
    echo "[boot] Failed to create workspace directory ${workspace_dir}" >&2
    return 1
  fi
  if ! git config --global --get-all safe.directory 2>/dev/null | grep -Fx -- "$workspace_dir" >/dev/null; then
    if ! git config --global --add safe.directory "$workspace_dir"; then
      echo "[boot] Failed to mark ${workspace_dir} as a safe Git directory" >&2
      return 1
    fi
  fi
  find "$workspace_dir" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + 2>/dev/null || true

  echo "[boot] Materializing GitHub base ${TILLER_GITHUB_BASE_COMMIT_SHA} into ${workspace_dir}"
  if ! git -C "$workspace_dir" init -q; then
    echo "[boot] Failed to initialize GitHub base checkout repository" >&2
    return 1
  fi
  if ! git -C "$workspace_dir" remote add origin "$REPO_URL"; then
    echo "[boot] Failed to configure GitHub base checkout remote" >&2
    return 1
  fi
  local fetch_timeout_seconds
  if ! fetch_timeout_seconds="$(remaining_startup_seconds)"; then
    echo "[boot] GitHub base checkout exceeded the startup deadline" >&2
    return 1
  fi
  if ! timeout --foreground "${fetch_timeout_seconds}s" git -C "$workspace_dir" fetch --depth 1 origin "$TILLER_GITHUB_BASE_COMMIT_SHA"; then
    echo "[boot] Failed to fetch GitHub base ${TILLER_GITHUB_BASE_COMMIT_SHA}" >&2
    return 1
  fi
  if ! git -C "$workspace_dir" checkout -q --detach FETCH_HEAD; then
    echo "[boot] Failed to check out GitHub base ${TILLER_GITHUB_BASE_COMMIT_SHA}" >&2
    return 1
  fi
}

write_startup_plan_document() {
  if [ -z "${TILLER_STARTUP_PLAN_DOCUMENT_B64:-}" ]; then
    return 0
  fi
  local workspace_dir="${TILLER_WORKSPACE_SYNC_WORKSPACE:-/workspace}"
  local plan_path="$workspace_dir/.tiller/plan.md"
  mkdir -p "$(dirname "$plan_path")"
  if ! printf '%s' "$TILLER_STARTUP_PLAN_DOCUMENT_B64" | base64 -d > "$plan_path"; then
    report_startup_failure_and_exit "workspace-sync" "Failed to decode startup plan document"
  fi
}

PERIODIC_PID=""
WATCHDOG_PID=""
STOP_CONTROL_PID=""
TILLER_PID=""
CLEANING_UP=false
STOP_CONTROL_PORT="${TILLER_STOP_CONTROL_PORT:-8790}"
STOP_PREPARED_FLAG_PATH="${TILLER_STOP_PREPARED_FLAG_PATH:-/tmp/tiller-stop-prepared}"
STOP_REQUESTED_FLAG_PATH="${TILLER_STOP_REQUESTED_FLAG_PATH:-/tmp/tiller-stop-requested}"
STOP_OP_ID_PATH="${TILLER_STOP_OP_ID_PATH:-/tmp/tiller-lifecycle-stop-op-id}"
STOP_CONTROL_HEALTH_URL="http://127.0.0.1:${STOP_CONTROL_PORT}/health"
STOP_CONTROL_LOG="/tmp/tiller-stop-control.log"
BOOTSTRAP_LOG="/tmp/tiller-bootstrap.log"
RUNNER_READY_MARKER_PATH="${TILLER_RUNNER_READY_MARKER_PATH:-/tmp/tiller-runner-ready}"
HARNESS_EXITED_MARKER_PATH="${TILLER_HARNESS_EXITED_MARKER_PATH:-/tmp/tiller-harness-exited}"
RUNNER_READY_MARKER_WAIT_SECONDS="${TILLER_RUNNER_READY_MARKER_WAIT_SECONDS:-15}"
RUNNER_READY_LOG_FALLBACK_WAIT_SECONDS="${TILLER_RUNNER_READY_LOG_FALLBACK_WAIT_SECONDS:-45}"
export TILLER_WORKSPACE_SYNC_LOCK_PATH="${TILLER_WORKSPACE_SYNC_LOCK_PATH:-/run/tiller/workspace-sync.lock}"
export TILLER_HARNESS_CONTROL_SOCKET="${TILLER_HARNESS_CONTROL_SOCKET:-/tmp/tiller-harness-control.sock}"

TILLER_LOG="/tmp/tiller-harness.log"

wait_for_stop_control() {
  local attempts="${1:-40}"
  local delay_seconds="${2:-0.25}"

  for _ in $(seq 1 "$attempts"); do
    if curl -fsS --max-time 1 "$STOP_CONTROL_HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi

    if [ -n "$STOP_CONTROL_PID" ] && ! kill -0 "$STOP_CONTROL_PID" 2>/dev/null; then
      wait "$STOP_CONTROL_PID" 2>/dev/null || true
      return 1
    fi

    sleep "$delay_seconds"
  done

  return 1
}

if [ -z "${TILLER_HARNESS:-}" ]; then
  echo "[boot] ERROR: TILLER_HARNESS is required" >&2
  exit 1
fi

HARNESS="$TILLER_HARNESS"
HARNESS_LABEL="Claude Code"
if [ "$HARNESS" = "codex" ]; then
  HARNESS_LABEL="Codex"
elif [ "$HARNESS" = "opencode" ]; then
  HARNESS_LABEL="OpenCode"
elif [ "$HARNESS" != "claude-code" ]; then
  echo "[boot] ERROR: TILLER_HARNESS must be claude-code, codex, or opencode" >&2
  exit 1
fi

cleanup() {
  local signal_exit_code="$?"
  # Guard against re-entry (SIGTERM during cleanup)
  if $CLEANING_UP; then return; fi
  CLEANING_UP=true

  # Under `set -e`, a `wait $PID` at the end of an `&& wait ...` chain will
  # abort this trap handler when the waited process exits non-zero (e.g. 143
  # after SIGTERM). That would skip /stop-finalize.sh and report_runner_stopped,
  # leaving the hub stuck in `stopping` until its 60s alarm fires.
  set +e

  local cleanup_exit_code=0
  local stop_finalize_rc=0
  local unexpected_cf_shutdown=false
  if [ "${RUNNER_BACKEND:-}" = "cf" ] && [ ! -f "$STOP_REQUESTED_FLAG_PATH" ]; then
    unexpected_cf_shutdown=true
  fi
  echo "Shutting down..."
  echo "[stop] cleanup start (signal_exit_code=${signal_exit_code}; stop_requested=$([ -f "$STOP_REQUESTED_FLAG_PATH" ] && printf '1' || printf '0'); stop_prepared=$([ -f "$STOP_PREPARED_FLAG_PATH" ] && printf '1' || printf '0'); op_id=$(resolve_stop_lifecycle_op_id))"
  [ -n "$WATCHDOG_PID" ] && kill "$WATCHDOG_PID" 2>/dev/null
  [ -n "$PERIODIC_PID" ] && kill "$PERIODIC_PID" 2>/dev/null && wait "$PERIODIC_PID" 2>/dev/null
  [ -n "$TILLER_PID" ] && kill "$TILLER_PID" 2>/dev/null && wait "$TILLER_PID" 2>/dev/null
  [ -n "$STOP_CONTROL_PID" ] && kill "$STOP_CONTROL_PID" 2>/dev/null && wait "$STOP_CONTROL_PID" 2>/dev/null

  if $unexpected_cf_shutdown; then
    # Cloudflare image rollouts and infrastructure replacement can send
    # SIGTERM without first creating a lifecycle Stop operation. Preserve the
    # writable layer using the no-ack sync mode before the container exits;
    # the running Start op is then failed explicitly below.
    TILLER_IDLE_STOP_PREPARE_ONLY=1 /stop-finalize.sh
  else
    /stop-finalize.sh
  fi
  stop_finalize_rc=$?
  if [ "$stop_finalize_rc" -ne 0 ]; then
    echo "[stop] workspace finalize failed or timed out (exit ${stop_finalize_rc})"
    cleanup_exit_code=1
  fi

  if [ "${RUNNER_BACKEND:-}" = "host" ] && [ -f "$STOP_REQUESTED_FLAG_PATH" ]; then
    report_runner_stopped \
      "$(build_stop_cleanup_message "$signal_exit_code" "$stop_finalize_rc")" \
      "$(resolve_stop_lifecycle_op_id)" || true
  elif $unexpected_cf_shutdown; then
    report_runner_stopped \
      "$(build_unexpected_cf_cleanup_message "$signal_exit_code" "$stop_finalize_rc")" \
      "${TILLER_LIFECYCLE_START_OP_ID:-}" || true
  fi
  echo "[stop] cleanup complete (stop_finalize_rc=${stop_finalize_rc}; cleanup_exit_code=${cleanup_exit_code})"
  exit "$cleanup_exit_code"
}

on_exit() {
  local exit_code="$?"
  if [ "$RUNNER_STOP_REPORTED" = "1" ]; then
    return 0
  fi
  if [ "${RUNNER_BACKEND:-}" != "host" ]; then
    return 0
  fi
  # Backstop: if cleanup() was interrupted before it could report, the
  # STOP_REQUESTED_FLAG is still present and RUNNER_STOP_REPORTED is still 0.
  # Send the callback here so the hub isn't left waiting on its stop alarm.
  if [ -f "$STOP_REQUESTED_FLAG_PATH" ]; then
    report_runner_stopped "container exited with code ${exit_code}; stop completed" "$(resolve_stop_lifecycle_op_id)" || true
    return 0
  fi
  if [ "$exit_code" -eq 0 ]; then
    return 0
  fi

  report_runner_stopped "$(build_runner_stopped_message "$exit_code")" || true
}

trap cleanup SIGTERM SIGINT
trap on_exit EXIT

initialize_startup_deadline
if ! preflight_workspace_sync_lock; then
  report_startup_failure_and_exit "workspace-sync" "Workspace startup preparation failed." "Workspace sync lock is unavailable."
fi

# --- Step 1/5: Mandatory workspace hydration ---
if [ -n "${TILLER_GITHUB_BASE_COMMIT_SHA:-}" ]; then
  report_progress "workspace-sync" "Checking out GitHub base..."
  if ! materialize_github_base; then
    report_startup_failure_and_exit "workspace-sync" "Workspace startup preparation failed." "GitHub base checkout did not complete."
  fi
fi

report_progress "workspace-sync" "Syncing workspace..."
sync_rc=0
sync_down || sync_rc=$?
if [ $sync_rc -ne 0 ]; then
  report_startup_failure_and_exit "workspace-sync" "Workspace startup preparation failed." "Workspace hydration exited ${sync_rc}." "$sync_rc"
fi
report_progress "workspace-sync" "Workspace synced"

write_startup_plan_document

if [ -f /workspace/core ]; then
  echo "[boot][workspace-sync] Removing runtime core dump from workspace"
  rm -f /workspace/core || true
fi

if [ -f /workspace/.claude/settings.local.json ]; then
  echo "[boot][workspace-sync] Removing workspace-local Claude settings"
  rm -f /workspace/.claude/settings.local.json || true
fi

# sync_down runs as root — fix ownership so the tiller user can write
chown -R tiller:tiller /workspace
for sync_state_path in \
  "${TILLER_WORKSPACE_SYNC_MANIFEST_CACHE:-/tmp/.workspace-manifest.json}" \
  "${TILLER_WORKSPACE_SYNC_LAST_SYNC:-/tmp/.last-sync}" \
  "${TILLER_WORKSPACE_SYNC_CURL_TMP:-/tmp/.sync-curl-body}"
do
  if [ -e "$sync_state_path" ]; then
    chown tiller:tiller "$sync_state_path" || true
    chmod a+rw "$sync_state_path" || true
  fi
done
rm -f "$STOP_PREPARED_FLAG_PATH" "$STOP_REQUESTED_FLAG_PATH" "$STOP_OP_ID_PATH" "$RUNNER_READY_MARKER_PATH" "$HARNESS_EXITED_MARKER_PATH"
: > "$BOOTSTRAP_LOG"

# --- Step 2/5: Verify baked tiller-harness ---
report_baked_tiller_harness

# --- Step 3/5: Background services ---
report_progress "stop-control" "Starting stop-control service..."

: > "$STOP_CONTROL_LOG"
node /stop-control-server.mjs >> "$STOP_CONTROL_LOG" 2>&1 &
STOP_CONTROL_PID=$!

if ! wait_for_stop_control; then
  report_progress "stop-control" "Stop-control service failed to start" "error"
  echo "[boot] ERROR: stop control service did not become healthy on ${STOP_CONTROL_HEALTH_URL}"
  if [ -s "$STOP_CONTROL_LOG" ]; then
    echo "[boot] stop control server output:"
    tail -50 "$STOP_CONTROL_LOG" || true
  fi
  report_startup_failure_and_exit "stop-control" "Stop-control service failed to start"
fi

# Periodic sync every 5 min (resilient — one failure doesn't kill the loop)
(
  while true; do
    sleep 300
    sync_up_with_retry || echo "[tiller] periodic sync failed after bounded retries (exit $?), will retry in 5m"
  done
) &
PERIODIC_PID=$!
report_progress "stop-control" "Stop-control service is healthy"
report_runner_infra_ready || true

# --- Step 4/5: Prepare harness handoff ---
report_progress "harness-launch" "Selected harness ${HARNESS}"

# --- Step 5/5: Verify prerequisites ---
report_progress "prereq-check" "Verifying prerequisites..."

# Check tiller-harness binary exists
if ! runuser -u tiller -- sh -c 'which tiller-harness' >/dev/null 2>&1; then
  report_progress "prereq-check" "tiller-harness binary not found in PATH" "error"
  report_startup_failure_and_exit "prereq-check" "tiller-harness not found in PATH"
fi

if [ "$HARNESS" = "opencode" ] && ! runuser -u tiller -- sh -c 'which opencode' >/dev/null 2>&1; then
  report_progress "prereq-check" "opencode binary not found in PATH" "error"
  report_startup_failure_and_exit "prereq-check" "opencode not found in PATH"
fi

# Check required env vars
missing=""
[ -z "$HUB_URL" ] && missing="$missing HUB_URL"
[ -z "$REPO_SLUG" ] && missing="$missing REPO_SLUG"

if [ "$HARNESS" = "codex" ]; then
  codex_app_server_ready=false
  if [ "${TILLER_CODEX_RUNTIME_MODE:-}" = "app-server" ] && [ -n "${TILLER_CODEX_RUNTIME_AUTH_URL:-}" ] && [ -n "${TILLER_RUNTIME_CAPABILITY:-}" ]; then
    codex_app_server_ready=true
  fi
  if [ -z "$OPENAI_API_KEY" ] && [ "$codex_app_server_ready" != "true" ]; then
    report_progress "prereq-check" "The selected Codex route is missing its required runtime credential" "error"
    report_startup_failure_and_exit "prereq-check" "Missing Codex auth configuration."
  fi
elif [ "$HARNESS" = "opencode" ]; then
  [ -z "$TILLER_OPENCODE_BASE_URL" ] && missing="$missing TILLER_OPENCODE_BASE_URL"
  [ -z "$TILLER_OPENCODE_AUTH_TOKEN" ] && missing="$missing TILLER_OPENCODE_AUTH_TOKEN"
  [ -z "$TILLER_OPENCODE_MODEL_ID" ] && missing="$missing TILLER_OPENCODE_MODEL_ID"
  [ -z "$TILLER_OPENCODE_MODEL_CONTEXT_LIMIT" ] && missing="$missing TILLER_OPENCODE_MODEL_CONTEXT_LIMIT"
  [ -z "$TILLER_OPENCODE_MODEL_OUTPUT_LIMIT" ] && missing="$missing TILLER_OPENCODE_MODEL_OUTPUT_LIMIT"
elif [ "$HARNESS" = "claude-code" ]; then
  if [ "$TILLER_CLAUDE_AUTH_RESOLVED_MODE" = "subscription" ]; then
    [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] && missing="$missing CLAUDE_CODE_OAUTH_TOKEN"
  elif [ "$TILLER_CLAUDE_AUTH_RESOLVED_MODE" = "api" ]; then
    [ -z "$ANTHROPIC_API_KEY" ] && missing="$missing ANTHROPIC_API_KEY"
  elif [ -z "$CLAUDE_CODE_OAUTH_TOKEN" ] && [ -z "$ANTHROPIC_API_KEY" ]; then
    missing="$missing CLAUDE_CODE_OAUTH_TOKEN|ANTHROPIC_API_KEY"
  fi
fi

if [ -n "$missing" ]; then
  report_progress "prereq-check" "Missing required env vars:$missing" "error"
  report_startup_failure_and_exit "prereq-check" "Missing required env vars:$missing"
fi

report_progress "prereq-check" "Prerequisites OK (${HARNESS_LABEL})"

report_progress "harness-launch" "Launching tiller-harness..."

if [ -n "$HUB_URL" ]; then
  # Claude and Codex containers need --skip-permissions for fully autonomous execution.
  # When using API key auth, also pass --bare so Claude Code uses ANTHROPIC_API_KEY
  # directly instead of attempting OAuth (which hangs in a headless container).
  # Both flags together = API key auth + no permission hooks.
  TILLER_HARNESS_AUTH_FLAG=""
  TILLER_HARNESS_ARGS=("$REPO_SLUG")
  if [ "$HARNESS" = "claude-code" ]; then
    TILLER_HARNESS_AUTH_FLAG="--skip-permissions"
    TILLER_HARNESS_ARGS+=(--skip-permissions)
    if use_claude_subscription_auth; then
      clear_claude_api_auth_env
    fi
    if [ "$TILLER_CLAUDE_AUTH_RESOLVED_MODE" = "api" ]; then
      TILLER_HARNESS_AUTH_FLAG="--bare --skip-permissions"
      TILLER_HARNESS_ARGS=("$REPO_SLUG" --bare --skip-permissions)
    fi
  elif [ "$HARNESS" = "codex" ]; then
    TILLER_HARNESS_AUTH_FLAG="--skip-permissions"
    TILLER_HARNESS_ARGS+=(--skip-permissions)
  fi
  TILLER_HARNESS_ARGS+=(--cwd /workspace --team default --role lead)

  if [ "$HARNESS" = "opencode" ]; then
    OPENCODE_LOCAL_DIR="/home/tiller/.local"
    OPENCODE_DATA_DIR="/home/tiller/.local/share/opencode"
    OPENCODE_CACHE_DIR="/home/tiller/.cache/opencode"
    OPENCODE_RUNTIME_STATE_DIR="/home/tiller/.local/state/opencode"
    OPENCODE_SEED_DIR="/opt/opencode-seed"
    OPENCODE_CONFIG_DIR="/home/tiller/.config/opencode"
    OPENCODE_THEME_DIR="${OPENCODE_CONFIG_DIR}/themes"
    OPENCODE_THEME_ID="tiller-light"
    OPENCODE_TUI_CONFIG_FILE="${OPENCODE_CONFIG_DIR}/tui.json"
    OPENCODE_TUI_STATE_FILE="${OPENCODE_RUNTIME_STATE_DIR}/tui"
    export OPENCODE_DISABLE_AUTOUPDATE=1
    export COLORTERM="${COLORTERM:-truecolor}"
    # OpenCode is prepared as root, but tiller-harness installs activity hooks
    # in the sibling ~/.config/tiller directory after dropping privileges.
    install -d -o tiller -g tiller -m 0755 /home/tiller/.config
    mkdir -p "$OPENCODE_LOCAL_DIR/state"
    mkdir -p "$OPENCODE_DATA_DIR" "$OPENCODE_CACHE_DIR" "$OPENCODE_RUNTIME_STATE_DIR"
    mkdir -p "$OPENCODE_CONFIG_DIR" "$OPENCODE_THEME_DIR"
    if ! directory_has_files "$OPENCODE_DATA_DIR" && directory_has_files "$OPENCODE_SEED_DIR/data"; then
      cp -R "$OPENCODE_SEED_DIR/data"/. "$OPENCODE_DATA_DIR"/
    fi
    if ! directory_has_files "$OPENCODE_CACHE_DIR" && directory_has_files "$OPENCODE_SEED_DIR/cache"; then
      cp -R "$OPENCODE_SEED_DIR/cache"/. "$OPENCODE_CACHE_DIR"/
    fi
    if ! directory_has_files "$OPENCODE_RUNTIME_STATE_DIR" && directory_has_files "$OPENCODE_SEED_DIR/state"; then
      cp -R "$OPENCODE_SEED_DIR/state"/. "$OPENCODE_RUNTIME_STATE_DIR"/
    fi
    if [ -f "$OPENCODE_TUI_STATE_FILE" ]; then
      if grep -q '^theme = ' "$OPENCODE_TUI_STATE_FILE"; then
        sed -i "s/^theme = .*/theme = \"${OPENCODE_THEME_ID}\"/" "$OPENCODE_TUI_STATE_FILE"
      else
        { printf 'theme = "%s"\n' "$OPENCODE_THEME_ID"; cat "$OPENCODE_TUI_STATE_FILE"; } > "${OPENCODE_TUI_STATE_FILE}.tmp"
        mv "${OPENCODE_TUI_STATE_FILE}.tmp" "$OPENCODE_TUI_STATE_FILE"
      fi
    else
      printf 'theme = "%s"\n' "$OPENCODE_THEME_ID" > "$OPENCODE_TUI_STATE_FILE"
    fi
    # Envs that briefly ran newer OpenCode builds may only contain the newer
    # SQLite database. The pinned OpenCode build ignores it, so seed its legacy
    # migration marker unless old JSON project data is present and needs a real
    # migration.
    if [ ! -f "$OPENCODE_DATA_DIR/storage/migration" ] \
      && [ -f "$OPENCODE_DATA_DIR/opencode.db" ] \
      && ! directory_has_files "$OPENCODE_DATA_DIR/project"; then
      mkdir -p "$OPENCODE_DATA_DIR/storage"
      printf '1' > "$OPENCODE_DATA_DIR/storage/migration"
    fi
    chown -R tiller:tiller "$OPENCODE_LOCAL_DIR"
    chown -R tiller:tiller "/home/tiller/.cache"
    # Let xterm supply the canvas and prompt backgrounds so this embedded theme
    # works on both Paperwing and Classic Light; keep overlays opaque.
    cat > "${OPENCODE_THEME_DIR}/${OPENCODE_THEME_ID}.json" <<'OCTHEMEOF'
{
  "$schema": "https://opencode.ai/theme.json",
  "theme": {
    "primary": "#2563eb",
    "secondary": "#7c3aed",
    "accent": "#0f766e",
    "error": "#dc2626",
    "warning": "#b45309",
    "success": "#15803d",
    "info": "#0369a1",
    "text": "#111827",
    "textMuted": "#4b5563",
    "background": "none",
    "backgroundPanel": "#ffffff",
    "backgroundElement": "none",
    "backgroundMenu": "#ffffff",
    "border": "#cbd5e1",
    "borderActive": "#2563eb",
    "borderSubtle": "#e2e8f0",
    "diffAdded": "#15803d",
    "diffRemoved": "#dc2626",
    "diffContext": "#4b5563",
    "diffHunkHeader": "#0369a1",
    "diffHighlightAdded": "#bbf7d0",
    "diffHighlightRemoved": "#fecaca",
    "diffAddedBg": "#dcfce7",
    "diffRemovedBg": "#fee2e2",
    "diffContextBg": "#f1f5f9",
    "diffLineNumber": "#64748b",
    "diffAddedLineNumberBg": "#bbf7d0",
    "diffRemovedLineNumberBg": "#fecaca",
    "markdownText": "#111827",
    "markdownHeading": "#1d4ed8",
    "markdownLink": "#2563eb",
    "markdownLinkText": "#1d4ed8",
    "markdownCode": "#7c2d12",
    "markdownBlockQuote": "#475569",
    "markdownEmph": "#7c3aed",
    "markdownStrong": "#111827",
    "markdownHorizontalRule": "#cbd5e1",
    "markdownListItem": "#0f766e",
    "markdownListEnumeration": "#0369a1",
    "markdownImage": "#2563eb",
    "markdownImageText": "#1d4ed8",
    "markdownCodeBlock": "#111827",
    "syntaxComment": "#64748b",
    "syntaxKeyword": "#7c3aed",
    "syntaxFunction": "#2563eb",
    "syntaxVariable": "#111827",
    "syntaxString": "#15803d",
    "syntaxNumber": "#b45309",
    "syntaxType": "#0f766e",
    "syntaxOperator": "#334155",
    "syntaxPunctuation": "#334155"
  }
}
OCTHEMEOF
    cat > "$OPENCODE_TUI_CONFIG_FILE" <<OCTUIEOF
{
  "\$schema": "https://opencode.ai/tui.json",
  "theme": "${OPENCODE_THEME_ID}"
}
OCTUIEOF
    if ! OPENCODE_CONFIG_CONTENT="$(tiller-opencode-config)"; then
      report_startup_failure_and_exit "harness-launch" "Failed to render selected OpenCode provider configuration"
    fi
    export OPENCODE_CONFIG_CONTENT
    # Also write config to the file path OpenCode scans, in case
    # OPENCODE_CONFIG_CONTENT env var isn't supported by this version.
    printf '%s\n' "$OPENCODE_CONFIG_CONTENT" > "${OPENCODE_CONFIG_DIR}/config.json"
    chown -R tiller:tiller "$OPENCODE_CONFIG_DIR"
    chmod 600 "${OPENCODE_CONFIG_DIR}/config.json"
  fi

  if [ "$HARNESS" = "codex" ]; then
    if [ "${TILLER_CODEX_RUNTIME_MODE:-}" = "app-server" ]; then
      report_progress "harness-launch" "Codex auth via ${TILLER_CODEX_AUTH_MODE:-unknown} app-server, flag=${TILLER_HARNESS_AUTH_FLAG}"
    elif [ -n "$OPENAI_API_KEY" ]; then
      report_progress "harness-launch" "Codex auth via API key, flag=${TILLER_HARNESS_AUTH_FLAG}"
    else
      report_progress "harness-launch" "Codex auth unresolved, flag=${TILLER_HARNESS_AUTH_FLAG}" "warn"
    fi
  elif [ "$HARNESS" = "opencode" ]; then
    report_progress "harness-launch" "OpenCode provider ${TILLER_OPENCODE_PROVIDER_KIND:-cloudflare-workers-ai} (${TILLER_OPENCODE_MODEL_ID})"
  elif use_claude_subscription_auth; then
    report_progress "harness-launch" "Claude auth via subscription token, flag=${TILLER_HARNESS_AUTH_FLAG}"
  elif [ "$TILLER_CLAUDE_AUTH_RESOLVED_MODE" = "api" ]; then
    report_progress "harness-launch" "Claude auth via Anthropic API key, flag=${TILLER_HARNESS_AUTH_FLAG}"
  else
    report_progress "harness-launch" "Auth mode=${TILLER_CLAUDE_AUTH_RESOLVED_MODE:-unset}, flag=${TILLER_HARNESS_AUTH_FLAG}"
  fi

  # Detect plan file written by research LLM
  PLAN_FILE="${PLAN_FILE:-/workspace/.tiller/plan.md}"
  if [ -s "$PLAN_FILE" ]; then
    report_progress "harness-launch" "Plan file detected, launching with plan..."
    TILLER_HARNESS_ARGS+=(--plan-file "$PLAN_FILE")
  fi

  export TILLER_RUNNER_READY_MARKER_PATH="$RUNNER_READY_MARKER_PATH"

  install -o tiller -g tiller -m 0644 /dev/null "$TILLER_LOG"

  # Launch via argv-style handoff so auth flags and plan-file paths do not rely
  # on shell string concatenation, and keep log redirection inside the tiller
  # shell so root does not need to reopen a user-owned log file.
  HARNESS_LAUNCHED=true
  runuser -u tiller -- env TILLER_LOG="$TILLER_LOG" bash -lc '
    cd /workspace || exit 1
    exec "$@" >> "$TILLER_LOG" 2>&1
  ' bash tiller-harness "${TILLER_HARNESS_ARGS[@]}" &
  TILLER_PID=$!

  echo "[boot] tiller-harness launched as pid ${TILLER_PID}, log at $TILLER_LOG"

  # --- Watchdog: monitor tiller-harness startup via direct process + readiness checks ---
  (
    # Give tiller-harness a few seconds to start
    sleep 3

    # Poll for actual hub connection, then wait for runner-ready marker first.
    for i in $(seq 1 24); do
      sleep 5

      if ! kill -0 "$TILLER_PID" 2>/dev/null; then
        report_progress "harness-launch" "tiller-harness exited during startup" "error"
        exit 0
      fi

      if grep -q "\[tiller\] Hub WebSocket connected" "$TILLER_LOG" 2>/dev/null; then
        report_progress "hub-connect" "tiller-harness connected to hub"

        # Prefer the explicit runner-ready marker. If it never appears, fall
        # back to log growth so startup diagnostics still degrade gracefully.
        log_size_at_hub_connect=$(wc -c < "$TILLER_LOG" 2>/dev/null || echo 0)
        for j in $(seq 1 "$RUNNER_READY_MARKER_WAIT_SECONDS"); do
          if [ -f "$RUNNER_READY_MARKER_PATH" ]; then
            report_progress "runner-ready" "${HARNESS_LABEL} is running"
            exit 0
          fi
          if ! kill -0 "$TILLER_PID" 2>/dev/null; then
            report_progress "harness-launch" "tiller-harness exited during startup" "error"
            exit 0
          fi
          sleep 1
        done

        fallback_checks=$((RUNNER_READY_LOG_FALLBACK_WAIT_SECONDS / 5))
        if [ "$fallback_checks" -lt 1 ]; then
          fallback_checks=1
        fi

        for j in $(seq 1 "$fallback_checks"); do
          if [ -f "$RUNNER_READY_MARKER_PATH" ]; then
            report_progress "runner-ready" "${HARNESS_LABEL} is running"
            exit 0
          fi
          sleep 5
          if ! kill -0 "$TILLER_PID" 2>/dev/null; then
            report_progress "harness-launch" "tiller-harness exited during startup" "error"
            exit 0
          fi
          log_size_now=$(wc -c < "$TILLER_LOG" 2>/dev/null || echo 0)
          delta=$((log_size_now - log_size_at_hub_connect))
          if [ "$delta" -gt 500 ]; then
            report_progress "runner-ready" "${HARNESS_LABEL} is running (log activity fallback; marker missing)"
            exit 0
          fi
        done
        report_progress "runner-ready" "tiller-harness connected but ${HARNESS_LABEL} may be stuck (no ready marker after ${RUNNER_READY_MARKER_WAIT_SECONDS}s and no output after $((RUNNER_READY_MARKER_WAIT_SECONDS + RUNNER_READY_LOG_FALLBACK_WAIT_SECONDS))s)" "warn"
        exit 0
      fi
    done

    # After 120s, no session established
    report_progress "hub-connect" "tiller-harness still starting after 120s (may be stuck)" "warn"
  ) &
  WATCHDOG_PID=$!

  # --- Main loop: wait for the direct tiller-harness child process ---
  TILLER_EXIT_CODE=0
  wait "$TILLER_PID" || TILLER_EXIT_CODE=$?
  printf '%s\n' "$TILLER_EXIT_CODE" > "$HARNESS_EXITED_MARKER_PATH"
  [ -n "$WATCHDOG_PID" ] && kill "$WATCHDOG_PID" 2>/dev/null && wait "$WATCHDOG_PID" 2>/dev/null
  WATCHDOG_PID=""
  TILLER_PID=""
  echo "[boot] tiller-harness exited (code ${TILLER_EXIT_CODE})"

  # Distinguish intentional stops from unexpected harness failure.
  # stop-requested is written by stop-control-server.mjs as soon as it
  # receives /prepare-stop from SandboxDO. Its presence means the env
  # lifecycle already initiated a stop — the exit is expected.
  if [ -f "$STOP_REQUESTED_FLAG_PATH" ]; then
    # Intentional stop path — request durable stop as before
    if [ "$TILLER_EXIT_CODE" = "0" ]; then
      report_progress "stop-control" "tiller-harness completed normally"
      wait_for_durable_stop_or_exit "tiller-harness completed normally"
    else
      report_progress "stop-control" "tiller-harness exited during stop (code ${TILLER_EXIT_CODE})" "warn"
      wait_for_durable_stop_or_exit "tiller-harness exited during stop"
    fi
  else
    if [ ! -f "$RUNNER_READY_MARKER_PATH" ]; then
      report_startup_failure_and_exit "harness-launch" "$(build_harness_failure_message "$TILLER_EXIT_CODE")"
    fi

    report_progress "harness-launch" "tiller-harness exited unexpectedly after startup (code ${TILLER_EXIT_CODE})" "error"
    report_harness_failure "$(build_harness_failure_message "$TILLER_EXIT_CODE")" || true
    wait
  fi
else
  report_progress "harness-launch" "No HUB_URL set — waiting for local processes only" "warn"
  wait
fi
