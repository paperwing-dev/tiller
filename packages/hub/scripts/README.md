# Hub deployment scripts

**This README is AI-generated.**

Fresh Hub installation is owned by `packages/installer`. The canonical Hub
release exports and scans the approved monorepo tree, publishes one synthetic
snapshot to `paperwing-dev/tiller`, and builds every release artifact from that
public commit. It then publishes one immutable Hub archive and
`ReleaseDescriptorV1`, deploys the installer with that descriptor, and checks
`/stable`. A failed Installer check restores the previous Worker traffic. The
installer also owns fixed-topology updates and Access renewal.

The root `npm run release` command owns this single coordinated patch or minor
release. Hub, Harness, Containers, and Installer move together. The CLI moves
only when its shipped source or compiler inputs changed, so a Hub-only release
does not require users to update the CLI.

`deploy-with-region.mjs` remains an internal maintainer helper used
by the root development validation workflow. It uses Cloudflare Automatic R2
placement, preserves the checkpointed maintainer-dev Durable Object hint when
configured, creates or reconciles the Automatic R2 bucket, supplies the
required `BUCKET` binding, preserves live Container images for Hub-only
development deploys, and accepts explicit validation-image overrides from
`scripts/deploy-dev.sh`. Run `npm run deploy:dev` from the repository root;
there is no package-level Hub deploy command.

Package and Hub version availability is checked before a release build begins.

For the first monorepo cutover, `paperwing-dev/tiller` must be public, the
release GitHub App must cover that repository with Contents and Actions write
access, and the public push credential must be allowed to update workflows.
The public repository also needs the Docker Hub secrets used by
`container-image.yml`. Selecting `reset_public_history` starts `main` at a new
root commit; it does not delete existing tags, releases, or Actions logs. Keep
the former `paperwing-dev/tiller-hub` repository publicly readable after the
cutover so descriptors from older installations can still fetch their release
assets.

Customer Workers are never deployed through this helper. The installer creates
the fixed `tiller` Worker and installation-ID-derived resources, configures
Access, and performs one final Hub upload. Fresh installation never adopts an
existing Worker; maintenance updates only the exact installer-managed Worker.
