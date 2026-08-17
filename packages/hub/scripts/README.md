# Hub deployment scripts

Fresh Hub installation is owned by `packages/installer`. The canonical Hub
release exports and scans the approved monorepo tree, publishes one synthetic
snapshot to `paperwing-dev/tiller`, rebuilds the release images, and publishes
one immutable Hub archive and `ReleaseDescriptorV1`. It then deploys the
installer with that descriptor and checks `/stable`. A failed Installer check
restores the previous Worker traffic. The installer also owns fixed-topology
updates and Access renewal.

The root `npm run release` command owns this single coordinated minor release.
Hub, Harness, Containers, and Installer move to the next minor every time. The
CLI moves only when its shipped source or compiler inputs changed, so a Hub-only
release does not require users to update the CLI.

`deploy-with-region.mjs` remains a legacy-named internal maintainer helper used
by the root development validation workflow. It uses Cloudflare Automatic R2
placement, preserves the checkpointed maintainer-dev Durable Object hint when
configured, creates or reconciles the Automatic R2 bucket, supplies the
required `BUCKET` binding, preserves live Container images for Hub-only
development deploys, and accepts explicit validation-image overrides from
`scripts/deploy-dev.sh`. Run `npm run deploy:dev` from the repository root;
there is no package-level Hub deploy command.

Package and Hub version availability is checked before a release build begins.

Customer Workers are never deployed through this helper. The installer creates
the fixed `tiller` Worker and installation-ID-derived resources, configures
Access, and performs one final Hub upload. Fresh installation never adopts an
existing Worker; maintenance updates only the exact installer-managed Worker.
