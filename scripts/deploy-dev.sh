#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HUB_DIR="$REPO_ROOT/packages/hub"
VALIDATION_WORKFLOW="validate-deploy.yml"
SELF_HOST_DEPLOY_RECORD="$REPO_ROOT/.update-self-host-deploy-record.json"
SELF_HOST_LOCAL_CONFIG="$REPO_ROOT/.update-self-host-dev.local.env"
MAINTAINER_DEV_CHECKPOINT="$REPO_ROOT/.tiller-dev-bootstrap.json"
MAINTAINER_DEV_ACCOUNT_ID=""
MAINTAINER_DEV_WORKER_NAME="tiller-dev"
MAINTAINER_DEV_PROFILE="maintainer-dev"
DEPLOY_TAG_NAME="tiller-deploy/dev"
DEPLOY_TAG_REF="refs/tags/$DEPLOY_TAG_NAME"

# shellcheck source=load-maintainer-dev-target.sh
source "$REPO_ROOT/scripts/load-maintainer-dev-target.sh"

VITE_PID=""
VITE_LOG=""
HUB_BUILD_LOCK_TOKEN=""
DEPLOY_MARKER_COMMIT=""
DEPLOY_MARKER_IS_ANCESTOR=false
FORCE_FULL_DEPLOY=false

cleanup() {
  [[ -n "$VITE_PID" ]] && kill "$VITE_PID" 2>/dev/null || true
  [[ -n "$VITE_LOG" ]] && rm -f "$VITE_LOG" || true
  if [[ -n "$HUB_BUILD_LOCK_TOKEN" ]]; then
    node "$REPO_ROOT/scripts/hub-build-lock.mjs" release "$HUB_BUILD_LOCK_TOKEN" >/dev/null || true
  fi
}
trap cleanup EXIT

acquire_hub_build_lock() {
  HUB_BUILD_LOCK_TOKEN="$(
    node "$REPO_ROOT/scripts/hub-build-lock.mjs" acquire "deploy:dev" "$$"
  )"
  export TILLER_HUB_BUILD_LOCK_TOKEN="$HUB_BUILD_LOCK_TOKEN"
}

fail_dirty_worktree() {
  echo "ERROR: worktree has uncommitted or untracked changes." >&2
  git -C "$REPO_ROOT" status --short --untracked-files=all >&2
  exit 1
}

require_clean_worktree() {
  [[ -z "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all)" ]] || fail_dirty_worktree
}

validate_deploy_arguments() {
  if [[ "$#" == "0" ]]; then
    return 0
  fi
  if [[ "$#" == "1" && "$1" == "--full" ]]; then
    FORCE_FULL_DEPLOY=true
    return 0
  fi
  echo "ERROR: unsupported development deploy arguments." >&2
  echo "Usage: npm run deploy:dev -- [--full]" >&2
  exit 1
}

validate_self_host_update_override() {
  case "${TILLER_SKIP_SELF_HOST_UPDATE:-}" in
    ""|1)
      ;;
    *)
      echo "ERROR: TILLER_SKIP_SELF_HOST_UPDATE must be 1 when set." >&2
      exit 1
      ;;
  esac
}

developer_self_host_is_configured() {
  [[ -f "$SELF_HOST_LOCAL_CONFIG" ]] \
    || [[ -n "${SELF_HOST_TARGET:-}" ]] \
    || [[ -n "${SELF_HOST_TARGET_LOCAL:-}" ]] \
    || [[ -n "${SELF_HOST_TARGET_REMOTE:-}" ]] \
    || [[ -n "${PI:-}" ]] \
    || [[ -n "${PI_LOCAL:-}" ]] \
    || [[ -n "${PI_REMOTE:-}" ]]
}

sync_developer_self_host_after_deploy() {
  local deploy_classification="$1"

  if [[ "$deploy_classification" == "hub-only" ]]; then
    echo "Self Host runtime image is unchanged; skipping developer host update."
    return 0
  fi

  if [[ "${TILLER_SKIP_SELF_HOST_UPDATE:-}" == "1" ]]; then
    echo "Skipping developer host update because TILLER_SKIP_SELF_HOST_UPDATE=1."
    return 0
  fi

  if ! developer_self_host_is_configured; then
    echo "No developer self-host target is configured; skipping host update."
    echo "Configure $SELF_HOST_LOCAL_CONFIG or run npm run update-host:local-env later."
    return 0
  fi

  echo "Synchronizing the configured developer self-host target..."
  if ! (cd "$REPO_ROOT" && npm run update-host:local-env); then
    echo "ERROR: deploy work completed, but the configured developer self-host update failed." >&2
    if [[ "$deploy_classification" == "full" ]]; then
      echo "The dev Hub and deploy marker may already be live; rerun npm run update-host:local-env after fixing the target." >&2
    fi
    return 1
  fi
}

configure_maintainer_dev_target() {
  load_maintainer_dev_target "$REPO_ROOT" "$MAINTAINER_DEV_CHECKPOINT"
  MAINTAINER_DEV_ACCOUNT_ID="$TILLER_MAINTAINER_DEV_ACCOUNT_ID"

  if [[ -n "${WRANGLER_CI_OVERRIDE_NAME:-}" ]]; then
    echo "ERROR: WRANGLER_CI_OVERRIDE_NAME is not allowed for the fixed maintainer dev deployment." >&2
    exit 1
  fi
  case "${TILLER_WORKER_NAME:-}" in
    ""|"$MAINTAINER_DEV_WORKER_NAME")
      ;;
    *)
      echo "ERROR: deploy:dev is fixed to Worker $MAINTAINER_DEV_WORKER_NAME." >&2
      exit 1
      ;;
  esac
  case "${CLOUDFLARE_ACCOUNT_ID:-}" in
    ""|"$MAINTAINER_DEV_ACCOUNT_ID")
      ;;
    *)
      echo "ERROR: deploy:dev is fixed to Cloudflare account $MAINTAINER_DEV_ACCOUNT_ID." >&2
      exit 1
      ;;
  esac
  case "${TILLER_DEPLOY_PROFILE:-}" in
    ""|"$MAINTAINER_DEV_PROFILE")
      ;;
    *)
      echo "ERROR: deploy:dev is fixed to profile $MAINTAINER_DEV_PROFILE." >&2
      exit 1
      ;;
  esac
  case "${TILLER_DEV_ALLOW_UNTRUSTED_SEED:-}" in
    ""|1)
      ;;
    *)
      echo "ERROR: TILLER_DEV_ALLOW_UNTRUSTED_SEED must be 1 when used by bootstrap:dev." >&2
      exit 1
      ;;
  esac

  export CLOUDFLARE_ACCOUNT_ID="$MAINTAINER_DEV_ACCOUNT_ID"
  export TILLER_WORKER_NAME="$MAINTAINER_DEV_WORKER_NAME"
  export TILLER_DEPLOY_PROFILE="$MAINTAINER_DEV_PROFILE"
  export TILLER_DEV_CHECKPOINT_PATH="$MAINTAINER_DEV_CHECKPOINT"

  (
    cd "$HUB_DIR"
    if [[ "${TILLER_DEV_ALLOW_UNTRUSTED_SEED:-}" == "1" ]]; then
      node scripts/verify-maintainer-dev-target.mjs --require-seeding-checkpoint
    else
      node scripts/verify-maintainer-dev-target.mjs --require-checkpoint
    fi
  )

  if [[ ! -f "$MAINTAINER_DEV_CHECKPOINT" ]]; then
    echo "ERROR: maintainer dev Access is not bootstrapped." >&2
    echo "Run \`npm run bootstrap:dev\` first." >&2
    exit 1
  fi
}

resolve_upstream() {
  local upstream_ref
  if ! upstream_ref="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref --symbolic-full-name "@{u}" 2>/dev/null)"; then
    echo "ERROR: current branch has no upstream. Push the branch and set an upstream first." >&2
    exit 1
  fi

  local remote="${upstream_ref%%/*}"
  local branch="${upstream_ref#*/}"
  git -C "$REPO_ROOT" fetch --quiet "$remote" "refs/heads/$branch:refs/remotes/$remote/$branch"
  printf '%s\n' "$upstream_ref"
}

require_head_at_upstream() {
  local upstream_ref="$1"
  local head_sha upstream_sha
  head_sha="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  upstream_sha="$(git -C "$REPO_ROOT" rev-parse "$upstream_ref")"
  if [[ "$head_sha" != "$upstream_sha" ]]; then
    echo "ERROR: local HEAD must exactly match upstream before deploy." >&2
    echo "Local HEAD: $head_sha" >&2
    echo "Upstream $upstream_ref: $upstream_sha" >&2
    exit 1
  fi
}

load_deploy_marker() {
  local commit_sha="$1"

  if git -C "$REPO_ROOT" fetch --force origin "$DEPLOY_TAG_REF:$DEPLOY_TAG_REF" >/dev/null 2>&1; then
    DEPLOY_MARKER_COMMIT="$(git -C "$REPO_ROOT" rev-list -n 1 "$DEPLOY_TAG_NAME")"
    echo "Fetched deploy marker $DEPLOY_TAG_NAME at $DEPLOY_MARKER_COMMIT" >&2
  else
    DEPLOY_MARKER_COMMIT=""
    DEPLOY_MARKER_IS_ANCESTOR=false
    echo "No remote deploy marker tag $DEPLOY_TAG_NAME found." >&2
    return 0
  fi

  if [[ "$(git -C "$REPO_ROOT" cat-file -t "$DEPLOY_TAG_REF")" != "tag" ]]; then
    echo "Deploy marker $DEPLOY_TAG_NAME has no portable deploy record; forcing a full deployment to replace it." >&2
    DEPLOY_MARKER_COMMIT=""
    DEPLOY_MARKER_IS_ANCESTOR=false
    return 0
  fi

  if ! git -C "$REPO_ROOT" for-each-ref --format='%(contents)' "$DEPLOY_TAG_REF" \
    | node "$REPO_ROOT/scripts/deploy-record.mjs" sync-tag "$SELF_HOST_DEPLOY_RECORD" "$DEPLOY_MARKER_COMMIT"; then
    echo "ERROR: deploy marker $DEPLOY_TAG_NAME does not contain a valid deploy record." >&2
    exit 1
  fi
  echo "Synchronized deploy record from $DEPLOY_TAG_NAME into $SELF_HOST_DEPLOY_RECORD" >&2

  if git -C "$REPO_ROOT" merge-base --is-ancestor "$DEPLOY_TAG_NAME" "$commit_sha"; then
    DEPLOY_MARKER_IS_ANCESTOR=true
  else
    DEPLOY_MARKER_IS_ANCESTOR=false
    echo "Deploy marker $DEPLOY_TAG_NAME is not an ancestor of $commit_sha." >&2
  fi
}

compute_rebuild_base() {
  local commit_sha="$1"

  if [[ -z "$DEPLOY_MARKER_COMMIT" ]]; then
    echo "No remote deploy marker tag $DEPLOY_TAG_NAME found; forcing base image rebuild." >&2
    printf 'true\n'
  elif [[ "$DEPLOY_MARKER_IS_ANCESTOR" != "true" ]]; then
    echo "Deploy marker $DEPLOY_TAG_NAME is not an ancestor of $commit_sha; forcing base image rebuild." >&2
    printf 'true\n'
  elif ! git -C "$REPO_ROOT" diff --quiet "$DEPLOY_TAG_NAME" "$commit_sha" -- packages/containers/Dockerfile.base; then
    echo "Dockerfile.base changed since $DEPLOY_TAG_NAME; forcing base image rebuild." >&2
    printf 'true\n'
  else
    echo "Dockerfile.base unchanged since $DEPLOY_TAG_NAME; reusing base image." >&2
    printf 'false\n'
  fi
}

classify_deploy_mode() {
  local commit_sha="$1"

  if [[ "$FORCE_FULL_DEPLOY" == "true" ]]; then
    printf 'full\n'
    return 0
  fi

  if [[ -z "$DEPLOY_MARKER_COMMIT" || "$DEPLOY_MARKER_IS_ANCESTOR" != "true" ]]; then
    printf 'full\n'
    return 0
  fi

  local changed_paths
  changed_paths="$(git -C "$REPO_ROOT" diff --name-only "$DEPLOY_TAG_NAME" "$commit_sha")"
  if [[ -z "$changed_paths" ]]; then
    printf 'full\n'
    return 0
  fi

  local saw_hub=false
  local saw_tiller=false
  local saw_other=false
  local path

  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    case "$path" in
      packages/hub/*)
        saw_hub=true
        ;;
      packages/tiller/*)
        saw_tiller=true
        ;;
      *)
        saw_other=true
        ;;
    esac
  done <<< "$changed_paths"

  if [[ "$saw_other" == "true" ]]; then
    printf 'full\n'
  elif [[ "$saw_hub" == "true" && "$saw_tiller" == "false" ]]; then
    printf 'hub-only\n'
  elif [[ "$saw_tiller" == "true" && "$saw_hub" == "false" ]]; then
    printf 'tiller-only\n'
  else
    printf 'full\n'
  fi
}

wait_for_validation_run() {
  local commit_sha="$1"
  local request_id="$2"
  local run_id=""

  for _ in $(seq 1 60); do
    run_id="$(gh run list --workflow="$VALIDATION_WORKFLOW" \
      --json databaseId,displayTitle,headSha \
      --jq ".[] | select(.headSha==\"$commit_sha\" and (.displayTitle | contains(\"$request_id\"))) | .databaseId" \
      2>/dev/null | head -1)"
    [[ -n "$run_id" ]] && break
    sleep 2
  done

  if [[ -z "$run_id" ]]; then
    echo "ERROR: validation workflow run was not found after 2 minutes. Check GitHub Actions manually." >&2
    exit 1
  fi

  printf '%s\n' "$run_id"
}

read_previous_deploy_record() {
  node "$REPO_ROOT/scripts/deploy-record.mjs" read "$SELF_HOST_DEPLOY_RECORD"
}

write_deploy_record() {
  local hub_commit_sha="$1"
  local image_commit_sha="$2"
  local sandbox_image="$3"
  local scm_image="$4"
  local reviewer_isolation_protocol="${5:-0}"

  node "$REPO_ROOT/scripts/deploy-record.mjs" write \
    "$SELF_HOST_DEPLOY_RECORD" \
    "$hub_commit_sha" \
    "$image_commit_sha" \
    "$sandbox_image" \
    "$scm_image" \
    "$reviewer_isolation_protocol"
}

build_hub_with_runtime_metadata() {
  local commit_sha="$1"
  local runtime_image_source_id="${2:-$commit_sha}"
  local runtime_sandbox_image="${3:-docker.io/jamieatlason/tiller-sandbox:$runtime_image_source_id}"
  local reviewer_isolation_protocol="${4:-0}"
  local hub_version

  hub_version="$(cd "$REPO_ROOT" && node -p "require('./packages/hub/package.json').version")"
  echo "Embedding development Self Host runtime $runtime_image_source_id in Tiller Hub v$hub_version."
  (
    cd "$HUB_DIR"
    TILLER_SELF_HOST_RUNTIME_IMAGE_SOURCE_ID="$runtime_image_source_id" \
    TILLER_SELF_HOST_RUNTIME_SANDBOX_IMAGE="$runtime_sandbox_image" \
    TILLER_REVIEWER_ISOLATION_PROTOCOL="$reviewer_isolation_protocol" \
    TILLER_BUILD_VERSION="$hub_version" \
    TILLER_BUILD_CHANNEL="development" \
      npm run build
  )
}

update_deploy_marker() {
  local commit_sha="$1"
  git -C "$REPO_ROOT" \
    -c user.name="${GIT_AUTHOR_NAME:-Tiller Deploy}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-deploy@paperwing.dev}" \
    tag -a -f --cleanup=verbatim -F "$SELF_HOST_DEPLOY_RECORD" "$DEPLOY_TAG_NAME" "$commit_sha"
  git -C "$REPO_ROOT" push --force origin "$DEPLOY_TAG_REF"
}

deploy_hub_only() {
  local commit_sha="$1"
  local previous_record previous_hub_commit previous_image_commit previous_sandbox_image previous_github_job_image previous_reviewer_isolation_protocol

  if ! previous_record="$(read_previous_deploy_record)"; then
    echo "Run \`npm run deploy:dev -- --full\` to reseed the deploy record." >&2
    exit 1
  fi
  previous_hub_commit="${previous_record%%$'\n'*}"
  local remaining="${previous_record#*$'\n'}"
  previous_image_commit="${remaining%%$'\n'*}"
  remaining="${remaining#*$'\n'}"
  previous_sandbox_image="${remaining%%$'\n'*}"
  remaining="${remaining#*$'\n'}"
  previous_github_job_image="${remaining%%$'\n'*}"
  previous_reviewer_isolation_protocol="${remaining#*$'\n'}"
  previous_reviewer_isolation_protocol="${previous_reviewer_isolation_protocol%%$'\n'*}"
  previous_github_job_image="${previous_github_job_image%%$'\n'*}"

  if [[ "$previous_hub_commit" != "$DEPLOY_MARKER_COMMIT" ]]; then
    echo "ERROR: deploy record hubCommitSha does not match deploy marker $DEPLOY_TAG_NAME." >&2
    echo "Deploy record: $previous_hub_commit" >&2
    echo "Deploy marker: $DEPLOY_MARKER_COMMIT" >&2
    echo "Run \`npm run deploy:dev -- --full\` to reseed the deploy record." >&2
    exit 1
  fi

  echo "Hub-only change detected; skipping validation image build."
  VITE_LOG="$(mktemp)"
  echo "Building hub..."
  if ! build_hub_with_runtime_metadata "$commit_sha" "$previous_image_commit" "$previous_sandbox_image" "$previous_reviewer_isolation_protocol" > "$VITE_LOG" 2>&1; then
    echo "ERROR: hub build failed:" >&2
    cat "$VITE_LOG" >&2
    exit 1
  fi

  echo "Deploying hub with previous SHA-pinned images..."
  cd "$HUB_DIR"
  CONTAINER_IMAGE_TAG="$previous_sandbox_image" \
  GITHUB_JOB_IMAGE_TAG="$previous_github_job_image" \
    node scripts/deploy-with-region.mjs

  write_deploy_record "$commit_sha" "$previous_image_commit" "$previous_sandbox_image" "$previous_github_job_image" "$previous_reviewer_isolation_protocol"
  echo "Recorded hub-only deploy in $SELF_HOST_DEPLOY_RECORD"

  update_deploy_marker "$commit_sha"
  echo "Updated deploy marker $DEPLOY_TAG_NAME -> $commit_sha"

  echo ""
  echo "Hub-only deployment complete:"
  echo "  hub commit: $commit_sha"
  echo "  image commit: $previous_image_commit"
  echo "  sandbox image: $previous_sandbox_image"
  echo "  GitHub job image: $previous_github_job_image"
  echo "  hub deployed"
}

deploy_tiller_only() {
  local previous_record previous_hub_commit

  echo "Only packages/tiller changed. No Cloudflare deploy is needed."

  if ! previous_record="$(read_previous_deploy_record)"; then
    echo "Run \`npm run deploy:dev -- --full\` to reseed the deploy record before updating the host." >&2
    exit 1
  fi

  previous_hub_commit="${previous_record%%$'\n'*}"
  if [[ "$previous_hub_commit" != "$DEPLOY_MARKER_COMMIT" ]]; then
    echo "ERROR: deploy record hubCommitSha does not match deploy marker $DEPLOY_TAG_NAME." >&2
    echo "Deploy record: $previous_hub_commit" >&2
    echo "Deploy marker: $DEPLOY_MARKER_COMMIT" >&2
    echo "Run \`npm run deploy:dev -- --full\` to reseed the deploy record before updating the host." >&2
    exit 1
  fi

  echo "Run npm run update-host:local-env to install local Tiller on the host."
}

deploy_full() {
  local commit_sha="$1"
  local branch="$2"
  local upstream_branch="$3"
  local request_id="$4"
  local rebuild_base run_id

  rebuild_base="$(compute_rebuild_base "$commit_sha")"

  echo "Triggering validation image build for $commit_sha..."
  gh workflow run "$VALIDATION_WORKFLOW" \
    --ref "$upstream_branch" \
    -f image_tag=deploy \
    -f rebuild_base="$rebuild_base" \
    -f upstream_ref="$UPSTREAM_REF" \
    -f request_id="$request_id"

  run_id="$(wait_for_validation_run "$commit_sha" "$request_id")"

  VITE_LOG="$(mktemp)"
  echo "Pre-building hub while validation images build..."
  (build_hub_with_runtime_metadata "$commit_sha" "$commit_sha" "docker.io/jamieatlason/tiller-sandbox:$commit_sha" "1" > "$VITE_LOG" 2>&1) &
  VITE_PID=$!

  echo "Watching validation workflow run $run_id..."
  gh run watch "$run_id" --exit-status

  if ! wait "$VITE_PID"; then
    echo "ERROR: hub build failed:" >&2
    cat "$VITE_LOG" >&2
    exit 1
  fi
  VITE_PID=""

  echo "Deploying hub with SHA-pinned images..."
  cd "$HUB_DIR"
  CONTAINER_IMAGE_TAG="docker.io/jamieatlason/tiller-sandbox:$commit_sha" \
  GITHUB_JOB_IMAGE_TAG="docker.io/jamieatlason/tiller-scm:$commit_sha" \
    node scripts/deploy-with-region.mjs

  write_deploy_record \
    "$commit_sha" \
    "$commit_sha" \
    "docker.io/jamieatlason/tiller-sandbox:$commit_sha" \
    "docker.io/jamieatlason/tiller-scm:$commit_sha" \
    "1"
  echo "Recorded deployed self-host image in $SELF_HOST_DEPLOY_RECORD"

  update_deploy_marker "$commit_sha"
  echo "Updated deploy marker $DEPLOY_TAG_NAME -> $commit_sha"

  echo ""
  echo "Deployment complete:"
  echo "  commit: $commit_sha"
  echo "  branch: ${branch:-$upstream_branch}"
  echo "  sandbox image: docker.io/jamieatlason/tiller-sandbox:$commit_sha"
  echo "  GitHub job image: docker.io/jamieatlason/tiller-scm:$commit_sha"
  echo "  hub deployed"
}

main() {
  validate_deploy_arguments "$@"
  validate_self_host_update_override
  acquire_hub_build_lock
  configure_maintainer_dev_target
  require_clean_worktree
  UPSTREAM_REF="$(resolve_upstream)"
  UPSTREAM_BRANCH="${UPSTREAM_REF#*/}"
  require_head_at_upstream "$UPSTREAM_REF"

  COMMIT_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  export TILLER_DEV_RELEASE_ID="$COMMIT_SHA"
  BRANCH="$(git -C "$REPO_ROOT" branch --show-current)"
  REQUEST_ID="deploy-${COMMIT_SHA:0:12}-$(date +%s)"
  load_deploy_marker "$COMMIT_SHA"
  DEPLOY_CLASSIFICATION="$(classify_deploy_mode "$COMMIT_SHA")"
  echo "Deploy classification: $DEPLOY_CLASSIFICATION"

  case "$DEPLOY_CLASSIFICATION" in
    hub-only)
      deploy_hub_only "$COMMIT_SHA"
      ;;
    tiller-only)
      deploy_tiller_only
      ;;
    full)
      deploy_full "$COMMIT_SHA" "$BRANCH" "$UPSTREAM_BRANCH" "$REQUEST_ID"
      ;;
    *)
      echo "ERROR: internal classifier returned unsupported mode: $DEPLOY_CLASSIFICATION" >&2
      exit 1
      ;;
  esac

  sync_developer_self_host_after_deploy "$DEPLOY_CLASSIFICATION"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
