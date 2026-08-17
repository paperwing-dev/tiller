# Release notes

## Control-plane security maintenance upgrade

This release separates installation-wide control authority from environment runtime authority. After installing the updated CLI, each installation requires one browser-owner approval so the encrypted connection flow can save a new control credential in the mode-0600 Tiller config.

Mixed-version runtimes are intentionally unsupported. Treat this upgrade as maintenance:

1. Stop all active environments.
2. Deploy the updated Hub and container image.
3. Install the updated Tiller CLI.
4. Run the normal interactive `tiller host update` flow for installed hosts.
5. Recreate environments so every container uses `TILLER_RUNTIME_CAPABILITY` and the updated runtime protocol.

If smoke checks fail, manually restore the previous Hub deployment, CLI version, and pinned container image before recreating environments again.
