# Tiller CLI

**This README is AI-generated.**

Local CLI for connecting to a Tiller Hub and preparing an optional execution
machine.

## Install

```bash
npm install -g @paperwing-dev/tiller@latest
```

If `@paperwing-dev` was previously configured for GitHub Packages, remove that
scoped registry first:

```bash
npm config delete @paperwing-dev:registry
```

For a fresh Debian or Ubuntu machine, a prerequisite bootstrap script is also
available:

```bash
curl -fsSL https://raw.githubusercontent.com/paperwing-dev/tiller/main/packages/tiller/scripts/install-host.sh | bash
```

It installs Node.js 22 and Docker. It does not install Tiller or register the
machine; use the full `tiller host setup` command from Hub Settings afterward.

## Connect to the Hub

Run:

```bash
tiller
```

On first use, enter the exact workers.dev URL for the Hub. The CLI opens an
owner-authenticated browser flow and creates an ephemeral P-256 key. The
browser receives only an ECDH-ES/A256GCM encrypted connection package; the CLI
decrypts it locally, validates its state, canonical Hub URL, and timestamps,
then saves the installation-wide Cloudflare Access service credential.

The persisted configuration has one `hubUrl`. Production URLs must have this
shape:

```text
https://<exact-host>.workers.dev
```

Custom domains, aliases, public-Hub flags, and manually supplied Access client
credentials are unsupported. If an old config contains only a custom-domain
URL, reconnect with:

```bash
tiller init --hub-url https://<exact-host>.workers.dev
```

Localhost URLs remain available for contributor development.

## Connect subscriptions

With the Codex and/or Claude CLI installed, connect subscription billing with:

```bash
tiller auth connect              # connect both providers
tiller auth connect codex        # connect or reconnect Codex only
tiller auth connect claude       # connect or reconnect Claude only
```

Codex login uses an isolated temporary cache and does not read or modify your
normal `CODEX_HOME`. Claude asks for one hidden token paste after
`claude setup-token`. Tiller then opens one owner approval and activates
subscription billing for each connected provider.

## Use Your Machine

Cloudflare Containers is the default execution backend. Settings is the only
place where the backend for new workloads changes.

To make a Linux or macOS machine available, copy the full command shown in
Settings:

```bash
tiller host setup --hub-url https://<exact-host>.workers.dev
```

Setup performs the complete machine-side workflow:

1. normalizes the local config and validates the exact workers.dev origin;
2. validates or renews the encrypted browser credential;
3. verifies Docker and the local runner;
4. pulls or validates the Hub-compatible runtime image;
5. creates and persists a machine UUID while keeping the hostname as its
   display name;
6. installs or updates the systemd or launchd service and starts it;
7. waits for a healthy advertisement to reach the Hub; and
8. prints the Settings URL.

Setup does not select the machine automatically. In Settings, click **Use this
machine** after it reports ready. Switching back uses **Use Cloudflare**.
Changes affect only newly created workloads.

The installation supports one live execution machine. A replacement can
connect after the previous machine is offline, but workloads pinned to the old
machine are never reassigned.

## Runtime Updates

The sandbox image is separate from the npm package. Setup pulls the managed
image automatically:

```text
docker.io/jamieatlason/tiller-sandbox:stable
```

Update the service and pin the runtime image advertised by the Hub with:

```bash
npm install -g @paperwing-dev/tiller@latest
tiller host update
```

`tiller host update --dry-run` reports the image, config path, service state,
and restart action without changing anything. The update preserves the
machine UUID. Existing workload containers retain the image with which they
were created; stop and start a workload normally to recreate its container on
the newer runtime. Custom image references remain a manual responsibility.

## Commands

```bash
tiller              # open the workload/session picker and attach
tiller --history    # attach with recent output replay
tiller init         # connect or update the canonical Hub URL
tiller auth connect # connect Codex and Claude subscriptions
tiller host setup   # prepare and start this execution machine
tiller host install-service # install or reinstall its persistent service
tiller host update  # update its managed runtime and persistent service
tiller host         # run the machine daemon in the foreground
tiller setup        # run setup and readiness checks
tiller doctor       # detailed configuration and service diagnostics
tiller doctor dns   # diagnose Hub DNS and repair stale macOS DNS state
tiller status       # local health and Hub connection status
tiller down         # stop the execution-machine service or foreground daemon
```

Configuration loading and daemon startup never open a browser. When a saved
credential is invalid, noninteractive commands fail with instructions to run
`tiller host setup`.

## Interactive Controls

In the picker:

- `↑` / `↓` moves the selection.
- `Enter` attaches.
- `s` starts or stops the selected workload.
- `d` deletes a stopped workload after confirmation.
- `n` creates a workload.
- `q` or `Ctrl+C` quits.

While attached:

- `Ctrl+B` returns to the picker.
- `Ctrl+]` sends abort to the remote session.
- `Ctrl+C` exits `tiller`.

## Maintainer Update Paths

Normal installed machines use `tiller host update`. Maintainer validation uses
different repository workflows:

```bash
npm run deploy:dev:update-host
npm run update-host:local-env
```

`deploy:dev:update-host` is the validation deployment path; after a full or
CLI-only deploy, it also updates a configured maintainer host.
`update-host:local-env` explicitly reuses the last validation deploy record.
When either path updates the host, it installs a locally packed CLI and pins the
machine to the validation image recorded in
`.update-self-host-deploy-record.json`.
Existing workload containers remain untouched so they can Stop and save on
their current image; the next Start recreates them from the pinned image.
Neither command is a substitute for the installed-host update path.
