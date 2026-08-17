load_maintainer_dev_target() {
  local tiller_repo_root="$1"
  local checkpoint_file="$2"
  local target_output
  local target_account_id
  local target_account_subdomain
  local node_env_option=""

  if [[ -f "$tiller_repo_root/.tiller-maintainer-dev.env" ]]; then
    node_env_option="--env-file=$tiller_repo_root/.tiller-maintainer-dev.env"
  fi

  if [[ -n "$node_env_option" ]]; then
    target_output="$(
      node \
        "$node_env_option" \
        "$tiller_repo_root/packages/hub/scripts/maintainer-dev-target.mjs" \
        "$checkpoint_file"
    )"
  else
    target_output="$(
      node \
        "$tiller_repo_root/packages/hub/scripts/maintainer-dev-target.mjs" \
        "$checkpoint_file"
    )"
  fi
  IFS=$'\t' read -r target_account_id target_account_subdomain <<< "$target_output"
  if [[ -z "$target_account_id" || -z "$target_account_subdomain" ]]; then
    echo "ERROR: maintainer dev target resolver returned an invalid result." >&2
    return 1
  fi

  export TILLER_MAINTAINER_DEV_ACCOUNT_ID="$target_account_id"
  export TILLER_MAINTAINER_DEV_ACCOUNT_SUBDOMAIN="$target_account_subdomain"
}
