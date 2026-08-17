import { describe, expect, it } from "vitest";
import {
  inferPlacementRegion,
  placementRegionDefinition,
} from "../../hub/shared/placement";

describe("placement region registry", () => {
  it.each([
    ["NA", "-100.0001", "wnam"],
    ["NA", "-100", "enam"],
    ["SA", undefined, "sam"],
    ["EU", "14.9999", "weur"],
    ["EU", "15", "eeur"],
    ["AS", "59.9999", "me"],
    ["AS", "60", "apac"],
    ["AF", undefined, "afr"],
    ["OC", undefined, "oc"],
  ])("maps %s at %s to %s", (continent, longitude, expected) => {
    expect(inferPlacementRegion({ continent, longitude })).toBe(expected);
  });

  it.each([
    undefined,
    null,
    {},
    { continent: "AN", longitude: "0" },
    { continent: "NA" },
    { continent: "EU", longitude: "" },
    { continent: "AS", longitude: "not-a-number" },
    { continent: "NA", longitude: "181" },
    { continent: "NA", longitude: "-181" },
  ])("fails inference for invalid geolocation %#", (value) => {
    expect(inferPlacementRegion(value)).toBeNull();
  });

  it("owns Container fallback constraints in the same registry", () => {
    expect(placementRegionDefinition("me").containerRegions).toEqual(["ME", "EEUR"]);
    expect(placementRegionDefinition("afr").containerRegions).toEqual(["AFR", "WEUR"]);
    expect(placementRegionDefinition("oc").containerRegions).toEqual(["OC", "APAC"]);
  });
});
