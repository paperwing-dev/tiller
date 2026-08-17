import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const UPDATE_HOST_SCRIPT = path.join(
  REPO_ROOT,
  "scripts",
  "update-self-host-dev.sh",
);

describe("developer self-host update", () => {
  it("keeps only the validation-image path", () => {
    const source = readFileSync(UPDATE_HOST_SCRIPT, "utf8");

    expect(source).toContain("resolve_local_env_release");
    expect(source).toContain("install_local_tiller_on_target");
    expect(source).toContain("config.localRunnerImage = image");
    expect(source).toContain("systemctl restart tiller-host.service");
    expect(source).not.toContain("tiller-deploy/release");
    expect(source).not.toContain("install_published_tiller_on_target");
    expect(source).not.toMatch(/docker\s+(?:rm|kill|stop)\b/);
  });
});
