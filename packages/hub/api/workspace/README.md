# Workspace

**This README is AI-generated.**

This folder contains the hosted workspace storage layer and the routes that expose it.

## Purpose

`workspace/` owns:

- `WorkspaceDO`, backed by Cloudflare Shell over Durable Object SQLite and R2
- manifest, file, directory, batch, deletion, and tar-download routes
- GitHub draft-overlay deletion tracking
- plan artifact materialization into an environment workspace

## Boundary

- runners can be local or Cloudflare-backed
- workspace state stays hosted
- durable workspace state is available independently of any one runner lifecycle

`workspace/` owns durable project files; `env/` owns execution lifecycle. Route
inputs are path-validated before they reach the Durable Object.
