# Tiller Hub

Tiller Hub is the main Tiller application and control plane. It runs in your
Cloudflare account, manages coding-agent sessions, and executes workloads in
Cloudflare Containers or on a connected machine.

## Develop

Local Hub development is not currently supported. To test a change, commit and
push it, then deploy the clean, pushed commit from the monorepo root:

```bash
npm install
npm run deploy:dev
```

This runs the repository's maintainer deployment and live verification checks.
The deploy requires the private maintainer checkpoint.

Run `npm test` or `npm run build` from `packages/hub` for source verification
before deploying.

## Environment definition compatibility

Environment definitions are forward-only. Builds that predate the optional
immutable `displayName` field reject definitions written by newer builds. To
recover after a rollback, restore a compatible Hub build or first back up each
affected definition and remove only its `displayName` field before starting the
older build. There is no feature flag, staged writer enablement, or backfill;
legacy definitions without the field remain supported.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request.
