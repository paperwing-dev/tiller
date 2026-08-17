# Tiller Harness

`tiller-harness` runs inside a Tiller environment. It connects to the Tiller
Hub, creates a session, starts the selected coding agent in a PTY, and relays
terminal I/O between the agent and connected Tiller clients.

## Supported Agents

- `claude-code` -> `claude`
- `codex` -> `codex`
- `opencode` -> `opencode`

## Setup

- Node.js 22
- `HUB_URL`, or `hubUrl` in `~/.config/tiller/config.json`
- `TILLER_HARNESS=claude-code|codex|opencode`
- The selected harness binary on `PATH`
- Cloudflare Access service-token credentials for the canonical protected
  workers.dev Hub
- the single provider route materialized by the Hub for this launch:
  - Claude Subscription: `CLAUDE_CODE_OAUTH_TOKEN`
  - Claude API: `ANTHROPIC_API_KEY`
  - OpenAI API: `OPENAI_API_KEY`
  - OpenAI Subscription: `TILLER_CODEX_RUNTIME_MODE=app-server` plus the
    supervisor-owned runtime-auth callback URL and capability

The harness does not choose between configured routes or fall back to another
credential. It sanitizes agent child environments immediately before spawn and
restores only the immutable execution profile claimed by the Hub. Subscription
credentials remain in the Codex app-server callback and are not inherited by
the TUI or tool children.

Environment variables take precedence over config file values:

```json
{
  "hubUrl": "https://tiller.example.com",
  "namespace": "my-namespace",
  "clientId": "<cf-access-client-id>.access",
  "clientSecret": "<cf-access-client-secret>"
}
```

Use `TILLER_CONFIG_PATH` for a non-default config file.

## Usage

```bash
TILLER_HARNESS=claude-code HUB_URL=https://tiller.example.com tiller-harness
tiller-harness my-session
tiller-harness --session-tag my-session
tiller-harness --cwd /workspace
tiller-harness --resume
tiller-harness --plan-file /tmp/plan.txt
```

Other runtime flags:

- `--bare` uses Claude API-key auth instead of OAuth/keychain auth.
- `--skip-permissions` runs Claude autonomously without permission hooks.
- `--team` and `--role` attach metadata to the hub session.

`Ctrl+C` is forwarded to the child harness. Press `Ctrl+C` twice within one second to stop `tiller-harness`.

## Development

From the repo root:

```bash
npm run build --workspace packages/harness
npm run test --workspace packages/harness
npm run cli --workspace packages/harness -- --resume
```

Development deploys are repo-level: use `npm run deploy:dev` from the root when changing code that needs to be baked into the hub or container images.

## Package

`tiller-harness` is published to npm as `@paperwing-dev/tiller-harness`.
Only `dist/` and `hooks/` are included.

```bash
npm install -g @paperwing-dev/tiller-harness
```

If you previously configured `@paperwing-dev` for GitHub Packages, remove that
scoped registry first:

```bash
npm config delete @paperwing-dev:registry
```
