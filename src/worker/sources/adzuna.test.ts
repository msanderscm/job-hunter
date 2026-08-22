import { describe, it, expect } from "vitest";
import { adzunaLocationOk } from "./adzuna";

describe("adzunaLocationOk", () => {
  it("returns true when criteria.locations is empty", () => {
    expect(adzunaLocationOk(null, "us", { locations: [], remote_ok: false })).toBe(true);
  });

  it("returns true when a criteria location names the configured country", () => {
    expect(adzunaLocationOk("New York, NY", "us", { locations: ["United States"], remote_ok: false })).toBe(true);
  });

  it("matches the country alias case-insensitively", () => {
    expect(adzunaLocationOk(null, "us", { locations: ["USA"], remote_ok: false })).toBe(true);
  });

  it("matches a city substring of a configured location", () => {
    expect(adzunaLocationOk("New York, NY", "gb", { locations: ["New York"], remote_ok: false })).toBe(true);
  });

  it("returns true for a null location when the country is satisfied", () => {
    expect(adzunaLocationOk(null, "us", { locations: ["United States"], remote_ok: false })).toBe(true);
  });

  it("returns false for a null location when the country is not named and there is no substring match", () => {
    expect(adzunaLocationOk(null, "us", { locations: ["Berlin"], remote_ok: false })).toBe(false);
  });

  it("returns true for remote location text when remote_ok is set", () => {
    expect(adzunaLocationOk("Remote", "us", { locations: ["Berlin"], remote_ok: true })).toBe(true);
  });

  it("returns false for remote location text when remote_ok is not set", () => {
    expect(adzunaLocationOk("Remote", "us", { locations: ["Berlin"], remote_ok: false })).toBe(false);
  });

  it("returns false when nothing matches", () => {
    expect(adzunaLocationOk("Berlin, Germany", "gb", { locations: ["United States"], remote_ok: false })).toBe(false);
  });
});
