# Environment API

**This README is AI-generated.**

This folder contains environment lifecycle and runner backend logic.

## Purpose

`env/` owns the parts of Tiller that manage runnable environments:

- create/start/stop/delete routes
- status normalization
- slug generation
- container auth resolution
- runner backend selection
- Cloudflare vs host runner implementations

## Boundaries

- workspace state is hosted separately
- execution is selected through the `cf` or `host` runner backend
- `routes.ts` exposes the environment API, while `service.ts`, `state.ts`, and
  `view.ts` build the durable projections used by those routes
- runtime capabilities and backend-specific launch details remain in this
  domain

The root `env-lifecycle.ts` and `EnvLifecycleDO` serialize long-running
lifecycle operations. `workspace/` owns durable files, and `env-review/` owns
implementation reviews.
