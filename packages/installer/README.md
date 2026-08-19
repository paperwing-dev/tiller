# Tiller installer

**This README is AI-generated.**

`install.paperwing.dev` is the OAuth lifecycle service for installer-managed
Tiller Hubs. Its public lifecycle endpoints are `GET /deploy`,
`GET /maintenance?intent=update|renew`, and `GET /stable`.

The installer:

1. creates a browser-bound OAuth state and PKCE verifier and redirects directly
   to Cloudflare;
2. accepts exactly one account and hands authorization to the one account-keyed
   Durable Object that owns all Cloudflare mutations;
3. for a fresh install, rejects every account that already has a Worker named
   `tiller`;
4. validates the release bundle, verifies Container image access, and only then
   creates one disabled Worker, fresh KV/R2 and Access resources, uploads the
   Hub once, creates its Container applications, and enables the Worker after
   exact readback;
5. probes health, unauthenticated rejection, and service-token access before
   revoking OAuth and opening the Hub.

Browser OAuth sessions and encrypted OAuth grants live for at most 30 minutes.
The account operation retains no OAuth credential after that boundary; a new
OAuth session can resume its non-secret cursor. Fresh resource creation fails
closed if an ambiguous create cannot be proven. Maintenance always re-reads the
managed Worker and advances toward the pinned target.

Maintenance first proves the exact fixed v1 Worker, binding, storage, Access,
and Container topology. It inherits both Worker secrets from the pinned active
version, uploads Worker code/assets, and then advances Container images in
descriptor order with a persisted patch/rollout/wait cursor. Access renewal
refreshes the existing service token in place and uses the same reconciler.

There is no topology-changing update, historical release catalog, rollback,
resource adoption, release channel, uninstall, or generalized cleanup engine.

Fresh installs observe Cloudflare Container registries but never mutate this
shared account state. Public Docker Hub images require no registry record, so
an empty list, Cloudflare's default registry, and the private-beta
`registry.cloudchamber.cfdata.org` marker all proceed directly without Docker
Hub credentials. A current credential-backed `DockerHub` record is preserved
when one already exists, but it is not required. An obsolete bare `docker.io`
record left by an earlier Tiller attempt is stopped before any Tiller resource
is created; remove it with `npx wrangler containers registries delete docker.io`
and start again.
Registry readback is diagnostic evidence, not proof that the Container
application API can use the image. If that API returns the exact
definite HTTP 400/code 1605 `IMAGE_REGISTRY_NOT_CONFIGURED` response, the
installer retries only that response for one persisted 60-second window and
logs bounded registry domain/kind snapshots. Expiry requires manual cleanup
because Tiller resources already exist. Other application failures retain the
existing fail-closed behavior. The registry is shared account state: Tiller
never records it as owned, creates it, changes it, or deletes it. Every v1 release image
must be digest-pinned under exactly `docker.io`.

Registry-readiness logs contain the support reference, release, decision,
bounded domain/kind metadata, HTTP status/error codes, and Ray ID. They never
contain the account ID, OAuth token, registry credential/key, response message,
or private job URL. Maintenance performs one best-effort registry observation
so an established account can be compared with a failing fresh account.

## Configuration

Set these secrets on the installer Worker:

- `CLOUDFLARE_OAUTH_CLIENT_ID`
- `CLOUDFLARE_OAUTH_CLIENT_SECRET`
- `INSTALLER_TOKEN_ENCRYPTION_KEY_V1` (32 random bytes, base64url encoded)

`PUBLIC_ORIGIN` and `OAUTH_REDIRECT_URI` are pinned in `wrangler.jsonc`.

## Commands

```bash
npm test --workspace packages/installer
npm run build --workspace packages/installer
npm run deploy --workspace packages/installer
```
