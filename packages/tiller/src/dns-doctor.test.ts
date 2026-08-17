import { describe, expect, it } from "vitest";
import { parseDnsDoctorArgs, renderScopedResolverConfig, resolveDnsDoctorHostname } from "./dns-doctor.js";

describe("dns-doctor", () => {
  it("parses repair args with explicit hostname and network service", () => {
    expect(parseDnsDoctorArgs([
      "repair",
      "--hostname",
      "tiller.example.com",
      "--network-service",
      "Wi-Fi",
    ])).toEqual({
      action: "repair",
      hostname: "tiller.example.com",
      networkService: "Wi-Fi",
    });
  });

  it("treats the first bare arg as the hostname when no action is given", () => {
    expect(parseDnsDoctorArgs(["tiller.example.com"])).toEqual({
      action: "status",
      hostname: "tiller.example.com",
    });
  });

  it("infers the hostname from the configured hub url", () => {
    expect(resolveDnsDoctorHostname(
      { action: "status" },
      { platform: "darwin", hubUrl: "https://tiller.example.com/" },
    )).toBe("tiller.example.com");
  });

  it("prefers an explicit hostname over the configured hub url", () => {
    expect(resolveDnsDoctorHostname(
      { action: "status", hostname: "override.example.com" },
      { platform: "darwin", hubUrl: "https://tiller.example.com/" },
    )).toBe("override.example.com");
  });

  it("renders a scoped resolver that only targets the hub hostname", () => {
    expect(renderScopedResolverConfig("tiller.example.com")).toBe([
      "# Added by tiller doctor dns repair for tiller.example.com",
      "nameserver 1.1.1.1",
      "nameserver 8.8.8.8",
      "",
    ].join("\n"));
  });
});
