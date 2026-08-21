#!/bin/bash
set -euo pipefail

STOP_TIMEOUT_SECONDS="${TILLER_STOP_TIMEOUT_SECONDS:-60}"
STOP_FAILED_URL="${TILLER_STOP_FAILED_URL:-}"
STOP_PREPARED_FLAG_PATH="${TILLER_STOP_PREPARED_FLAG_PATH:-/tmp/tiller-stop-prepared}"
STOP_OP_ID_PATH="${TILLER_STOP_OP_ID_PATH:-/tmp/tiller-lifecycle-stop-op-id}"
WORKSPACE_SYNC_LOCK_PATH="${TILLER_WORKSPACE_SYNC_LOCK_PATH:-/run/tiller/workspace-sync.lock}"
IDLE_STOP_PREPARE_ONLY="${TILLER_IDLE_STOP_PREPARE_ONLY:-0}"
SKIP_WORKSPACE_SYNC_ACK="${TILLER_SKIP_WORKSPACE_SYNC_ACK:-0}"

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr '\n' ' '
}

collect_auth_headers() {
  local headers=()
  if [ -n "${CF_ACCESS_CLIENT_ID:-}" ] && [ -n "${CF_ACCESS_CLIENT_SECRET:-}" ]; then
    headers+=(
      -H "CF-Access-Client-Id: ${CF_ACCESS_CLIENT_ID}"
      -H "CF-Access-Client-Secret: ${CF_ACCESS_CLIENT_SECRET}"
    )
  fi
  if [ -n "${TILLER_RUNTIME_CAPABILITY:-}" ]; then
    headers+=(-H "X-Tiller-Capability: ${TILLER_RUNTIME_CAPABILITY}")
  fi
  if [ "${#headers[@]}" -gt 0 ]; then
    printf '%s\n' "${headers[@]}"
  fi
}

resolve_stop_failed_url() {
  if [ -n "$STOP_FAILED_URL" ]; then
    printf '%s\n' "$STOP_FAILED_URL"
    return 0
  fi
  if [ -n "${HUB_URL:-}" ] && [ -n "${REPO_SLUG:-}" ]; then
    printf '%s/api/envs/%s/stop-failed\n' "${HUB_URL%/}" "$REPO_SLUG"
    return 0
  fi
  return 1
}

resolve_workspace_synced_url() {
  if [ -n "${HUB_URL:-}" ] && [ -n "${REPO_SLUG:-}" ]; then
    printf '%s/api/envs/%s/workspace-synced\n' "${HUB_URL%/}" "$REPO_SLUG"
    return 0
  fi
  return 1
}

resolve_boot_progress_url() {
  if [ -n "${HUB_URL:-}" ] && [ -n "${REPO_SLUG:-}" ]; then
    printf '%s/api/envs/%s/boot-progress\n' "${HUB_URL%/}" "$REPO_SLUG"
    return 0
  fi
  return 1
}

report_stop_progress() {
  local message="$1"
  local progress_url=""
  progress_url="$(resolve_boot_progress_url 2>/dev/null || true)"
  if [ -z "$progress_url" ]; then
    return 0
  fi

  local auth_headers=()
  while IFS= read -r line; do
    if [ -n "$line" ]; then
      auth_headers+=("$line")
    fi
  done < <(collect_auth_headers)

  local payload
  payload=$(printf '{"message":"%s","stepId":"workspace-sync"}' "$(json_escape "$message")")

  local curl_args=(
    -sS
    -o /dev/null
    -w '%{http_code}'
    -X POST
    --max-time 2
    -H "Content-Type: application/json"
    --data-raw "$payload"
  )
  if [ "${#auth_headers[@]}" -gt 0 ]; then
    curl_args+=("${auth_headers[@]}")
  fi
  curl_args+=("$progress_url")

  local http_code
  http_code="$(curl "${curl_args[@]}")" || http_code="curl_error"
  [ "$http_code" = "200" ]
}

report_stop_failure() {
  local message="$1"
  local lifecycle_op_id="${2:-}"
  local failure_url=""
  failure_url="$(resolve_stop_failed_url 2>/dev/null || true)"
  if [ -z "$failure_url" ]; then
    echo "[stop] stop failure callback skipped because no failure URL is available"
    return 0
  fi

  local auth_headers=()
  while IFS= read -r line; do
    if [ -n "$line" ]; then
      auth_headers+=("$line")
    fi
  done < <(collect_auth_headers)

  local curl_args=(
    -sS
    -o /dev/null
    -w '%{http_code}'
    -X POST
    --max-time 10
    -H "Content-Type: text/plain"
  )
  if [ -n "$lifecycle_op_id" ]; then
    curl_args+=(-H "X-Tiller-Lifecycle-Op-Id: ${lifecycle_op_id}")
  fi
  if [ "${#auth_headers[@]}" -gt 0 ]; then
    curl_args+=("${auth_headers[@]}")
  fi
  curl_args+=("$failure_url" --data-raw "$message")

  local http_code
  http_code="$(curl "${curl_args[@]}")" || http_code="curl_error"
  if [ "$http_code" != "200" ]; then
    echo "[stop] stop failure callback failed (HTTP $http_code)"
    return 1
  fi

  return 0
}

ack_workspace_synced() {
  local lifecycle_op_id="$1"
  local workspace_last_synced_at="$2"
  local ack_url=""
  ack_url="$(resolve_workspace_synced_url 2>/dev/null || true)"
  if [ -z "$ack_url" ]; then
    echo "[stop] workspace-synced ack skipped because no URL is available"
    return 1
  fi

  local auth_headers=()
  while IFS= read -r line; do
    if [ -n "$line" ]; then
      auth_headers+=("$line")
    fi
  done < <(collect_auth_headers)

  local curl_args=(
    -sS
    -o /dev/null
    -w '%{http_code}'
    -X POST
    --max-time 10
    -H "X-Tiller-Lifecycle-Op-Id: ${lifecycle_op_id}"
  )
  if [ -n "$workspace_last_synced_at" ]; then
    curl_args+=(-H "X-Tiller-Workspace-Last-Synced-At: ${workspace_last_synced_at}")
  fi
  if [ "${#auth_headers[@]}" -gt 0 ]; then
    curl_args+=("${auth_headers[@]}")
  fi
  curl_args+=("$ack_url")

  local http_code
  http_code="$(curl "${curl_args[@]}")" || http_code="curl_error"
  if [ "$http_code" != "200" ]; then
    echo "[stop] workspace-synced ack failed (HTTP $http_code)"
    return 1
  fi

  echo "[stop] workspace-synced ack sent (op_id=${lifecycle_op_id})"
  return 0
}

iso_now_utc() {
  date -u +"%Y-%m-%dT%H:%M:%S.000Z"
}

echo "Saving workspace (${STOP_TIMEOUT_SECONDS}s timeout)..."
if [ "$IDLE_STOP_PREPARE_ONLY" != "1" ] && [ -f "$STOP_PREPARED_FLAG_PATH" ]; then
  echo "[stop] workspace already prepared before shutdown"
  exit 0
fi
STOP_LIFECYCLE_OP_ID="${TILLER_LIFECYCLE_OP_ID:-}"
if [ -z "$STOP_LIFECYCLE_OP_ID" ] && [ -s "$STOP_OP_ID_PATH" ]; then
  STOP_LIFECYCLE_OP_ID="$(cat "$STOP_OP_ID_PATH" 2>/dev/null || true)"
fi
if [ "$IDLE_STOP_PREPARE_ONLY" != "1" ] && [ -z "$STOP_LIFECYCLE_OP_ID" ]; then
  failure_message="Stop failed before workspace persistence completed; no lifecycle op id available."
  echo "[stop] ${failure_message}"
  exit 1
fi

sync_rc=0
report_stop_progress "Checking workspace for changes..." || true
set +e
timeout "${STOP_TIMEOUT_SECONDS}" flock -w "${STOP_TIMEOUT_SECONDS}" \
  "$WORKSPACE_SYNC_LOCK_PATH" node /workspace-sync.mjs up
sync_rc=$?
set -e

if [ "$sync_rc" -ne 0 ]; then
  if [ "$sync_rc" -eq 124 ]; then
    failure_message="Stop failed before workspace persistence completed; workspace sync timed out."
  else
    failure_message="Stop failed before workspace persistence completed; workspace sync exited ${sync_rc}."
  fi
  echo "[stop] ${failure_message}"
  if [ "$IDLE_STOP_PREPARE_ONLY" != "1" ]; then
    report_stop_failure "$failure_message" "$STOP_LIFECYCLE_OP_ID" || true
  fi
  exit "$sync_rc"
fi

if [ "$IDLE_STOP_PREPARE_ONLY" = "1" ]; then
  report_stop_progress "Workspace saved. Confirming idle stop eligibility..." || true
  echo "[stop] idle-stop workspace sync complete"
  exit 0
fi

if [ "$SKIP_WORKSPACE_SYNC_ACK" = "1" ]; then
  report_stop_progress "Workspace saved. Confirming with the Hub..." || true
  echo "[stop] strict workspace sync complete; Hub owns the lifecycle acknowledgement"
  exit 0
fi

WORKSPACE_SYNCED_AT="$(iso_now_utc)"

report_stop_progress "Confirming workspace saved..." || true
set +e
ack_workspace_synced "$STOP_LIFECYCLE_OP_ID" "$WORKSPACE_SYNCED_AT"
ack_rc=$?
set -e

if [ "$ack_rc" -ne 0 ]; then
  failure_message="Stop failed before workspace persistence completed; workspace ack failed."
  echo "[stop] ${failure_message}"
  report_stop_failure "$failure_message" "$STOP_LIFECYCLE_OP_ID" || true
  exit "$ack_rc"
fi

report_stop_progress "Workspace saved. Waiting for the container to stop..." || true
exit 0
