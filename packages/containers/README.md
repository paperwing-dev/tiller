# Tiller Containers

Docker images and startup scripts for Tiller's isolated coding-agent environments.

This package is used by both Cloudflare Containers and `tiller host` Docker
runs on Your machine. The images provide the sandbox, install the agent
CLIs, sync workspace files, and launch `tiller-harness`.

## What's Inside

- `Dockerfile.base`: shared Ubuntu/Node.js base image with Claude Code, Codex,
  OpenCode, and the non-root `tiller` user.
- `Dockerfile`: full sandbox image used for agent sessions. It adds
  `tiller-harness`, workspace sync, stop control, auth setup, and git helpers.
- `Dockerfile.scm`: smaller image for repository bootstrap and other git-only
  operations.
- `scripts/`: entrypoint, workspace sync, shutdown, auth, and SCM helper scripts.
- `__tests__/`: Vitest coverage for the runtime scripts.

## Runtime Flow

When a sandbox container starts, it:

1. syncs the workspace into `/workspace`
2. starts the stop-control service
3. prepares auth and runtime files for the selected harness
4. launches `tiller-harness` as the `tiller` user
5. syncs workspace changes back during shutdown

Plan Writers use a separate bootstrap branch in this same
image. That branch checks out the plan's frozen basis commit as root-owned
read-only files, skips workspace synchronization and environment services, and
runs `tiller-plan-writer`. The supervisor retains the generation-scoped Hub
credential while Claude Code or Codex runs as the unprivileged `tiller` user
with an explicit provider-auth environment allowlist and no MCP configuration.
The image pins the supported Claude Code and Codex versions; no runtime feature
flag or activation marker is required.

The SCM image runs only the bootstrap or git operation requested by
`TILLER_BOOTSTRAP_MODE`.

## Development

Run the container package tests from the repo root:

```bash
npm run test --workspace packages/containers
```

For normal validation and deployment, use the root `npm run deploy:dev` flow. It
keeps the hub config, harness package, and published container image tags pinned
to the same commit.

If you need to build the sandbox image by hand, first prepare the harness tarball:

```bash
npm run build --workspace packages/harness
npm pack --workspace packages/harness --pack-destination packages/containers
mv packages/containers/paperwing-dev-tiller-harness-*.tgz packages/containers/tiller-harness.tgz
docker build -f packages/containers/Dockerfile \
  --build-arg TILLER_IMAGE_COMMIT="$(git rev-parse HEAD)" \
  -t tiller-sandbox:local \
  packages/containers
```
