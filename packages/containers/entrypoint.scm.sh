#!/bin/bash
set -euo pipefail

if [ -n "${TILLER_GITHUB_BRIDGE_ID:-}" ] && [ -n "${TILLER_GITHUB_BRIDGE_SECRET:-}" ] && [ -n "${TILLER_GITHUB_ALLOWED_REPO:-}" ]; then
  git config --global credential.https://github.com.helper /usr/local/bin/git-credential-tiller
  git config --global credential.https://github.com.useHttpPath true
fi

case "${TILLER_BOOTSTRAP_MODE:-}" in
  github-env-publish)
    exec node /github-env-publish.mjs
    ;;
  *)
    echo "[entrypoint.scm] unsupported bootstrap mode: ${TILLER_BOOTSTRAP_MODE:-<unset>}" >&2
    exit 1
    ;;
esac
