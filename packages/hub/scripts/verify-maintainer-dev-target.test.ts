import { describe, expect, it } from "vitest";
import {
  MAINTAINER_DEV_ACCOUNT_ID,
  MAINTAINER_DEV_PROFILE_NAME,
  MAINTAINER_DEV_WORKER_NAME,
} from "./maintainer-dev-profile.mjs";
import {
  assertMaintainerDevEnvironment,
  assertWranglerIdentity,
} from "./verify-maintainer-dev-target.mjs";

describe("maintainer dev credential guard", () => {
  it("accepts only the fixed deployment tuple", () => {
    expect(() => assertMaintainerDevEnvironment({
      CLOUDFLARE_ACCOUNT_ID: MAINTAINER_DEV_ACCOUNT_ID,
      TILLER_WORKER_NAME: MAINTAINER_DEV_WORKER_NAME,
      TILLER_DEPLOY_PROFILE: MAINTAINER_DEV_PROFILE_NAME,
    })).not.toThrow();
    expect(() => assertMaintainerDevEnvironment({
      CLOUDFLARE_ACCOUNT_ID: MAINTAINER_DEV_ACCOUNT_ID,
      TILLER_WORKER_NAME: "tiller",
      TILLER_DEPLOY_PROFILE: MAINTAINER_DEV_PROFILE_NAME,
    })).toThrow(/TILLER_WORKER_NAME/);
  });

  it("requires Wrangler credentials scoped to only the expected account", () => {
    expect(assertWranglerIdentity({
      loggedIn: true,
      accounts: [{ id: MAINTAINER_DEV_ACCOUNT_ID }],
    })).toMatchObject({ loggedIn: true });
    expect(() => assertWranglerIdentity({
      loggedIn: true,
      accounts: [{ id: MAINTAINER_DEV_ACCOUNT_ID }, { id: "another-account" }],
    })).toThrow(/only the maintainer dev account/);
  });
});
