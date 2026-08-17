#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAINTAINER_DEV_CHECKPOINT="$REPO_ROOT/.tiller-dev-bootstrap.json"

# shellcheck source=load-maintainer-dev-target.sh
source "$REPO_ROOT/scripts/load-maintainer-dev-target.sh"
load_maintainer_dev_target "$REPO_ROOT" "$MAINTAINER_DEV_CHECKPOINT"

cd "$REPO_ROOT"
exec npx --no-install tsx packages/hub/scripts/maintainer-dev-bootstrap.ts "$@"
