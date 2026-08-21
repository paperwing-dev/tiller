# API Tests

**This README is AI-generated.**

This folder contains cross-cutting API tests that do not belong to one
subsystem directory.

## Purpose

Coverage includes:

- setup, Access, CLI bootstrap, and control-plane authorization
- environment lifecycle, execution selection, and runtime compatibility
- repository, GitHub, workspace-sync, and publication flows
- sessions, terminal attachment, planner runs, and scheduled runs
- Worker exports, release/update behavior, and deployment contracts

Subsystem-specific tests remain next to their production folders, such as
`env/__tests__/`, `planner/__tests__/`, and `workspace/__tests__/`.

Run all Hub tests from the repository root with:

```bash
npm run test --workspace packages/hub
```
