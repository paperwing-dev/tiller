#!/usr/bin/env bash
set -euo pipefail

bindings_dir="${1:-}"
cleanup_bindings=false
if [ -z "$bindings_dir" ]; then
  bindings_dir="$(mktemp -d /tmp/tiller-codex-reviewer-bindings.XXXXXX)"
  cleanup_bindings=true
  codex app-server generate-ts --experimental --out "$bindings_dir"
fi

cleanup() {
  if [ "$cleanup_bindings" = "true" ]; then
    rm -rf "$bindings_dir"
  fi
}
trap cleanup EXIT

test -d "$bindings_dir"
grep -Fq '"method": "environment/info"' "$bindings_dir/ClientRequest.ts"
grep -Fq 'environmentId: string' "$bindings_dir/v2/EnvironmentInfoParams.ts"
grep -Fq 'shell: EnvironmentShellInfo' "$bindings_dir/v2/EnvironmentInfoResponse.ts"
grep -Fq 'name: string' "$bindings_dir/v2/EnvironmentShellInfo.ts"
grep -Fq 'path: string' "$bindings_dir/v2/EnvironmentShellInfo.ts"
grep -Fq 'environmentId: string, cwd: LegacyAppPathString' "$bindings_dir/v2/TurnEnvironmentParams.ts"
grep -Fq 'environments?: Array<TurnEnvironmentParams> | null' "$bindings_dir/v2/ThreadStartParams.ts"
grep -Fq 'environments?: Array<TurnEnvironmentParams> | null' "$bindings_dir/v2/TurnStartParams.ts"
grep -Fq 'cwd: LegacyAppPathString' "$bindings_dir/v2/ThreadItem.ts"
grep -Fq 'status: CommandExecutionStatus' "$bindings_dir/v2/ThreadItem.ts"
grep -Fq 'commandActions: Array<CommandAction>' "$bindings_dir/v2/ThreadItem.ts"
grep -Fq 'exitCode: number | null' "$bindings_dir/v2/ThreadItem.ts"
grep -Fq '"type": "read"' "$bindings_dir/v2/CommandAction.ts"
grep -Fq '"type": "listFiles"' "$bindings_dir/v2/CommandAction.ts"
grep -Fq '"type": "search"' "$bindings_dir/v2/CommandAction.ts"
