import { describe, expect, it } from "vitest";
import { redactEnvValues, SESSION_ENV_NAMES_VAR } from "./redaction.js";

describe("redactEnvValues", () => {
  it("redacts short repo session env values but keeps short non-session values", () => {
    expect(redactEnvValues("PIN abc, MODE xy, HTTP 200", {
      [SESSION_ENV_NAMES_VAR]: "PIN,MODE",
      PIN: "abc",
      MODE: "xy",
      STATUS: "200",
    })).toBe("PIN [redacted], MODE [redacted], HTTP 200");
  });
});
