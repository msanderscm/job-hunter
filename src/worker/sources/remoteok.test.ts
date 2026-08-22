import { describe, it, expect } from "vitest";
import { remoteokJobOk } from "./remoteok";

const baseCriteria = { required_keywords: [], excluded_keywords: [], locations: [], remote_ok: false };

describe("remoteokJobOk", () => {
  it("keeps a job when remote_ok is true regardless of locations", () => {
    const text = "senior developer acme remote";
    const locationText = "remote";
    expect(
      remoteokJobOk(text, locationText, { ...baseCriteria, remote_ok: true, locations: ["Berlin"] })
    ).toBe(true);
  });

  it("keeps a job when remote_ok is false and locations is empty", () => {
    const text = "senior developer acme worldwide";
    const locationText = "worldwide";
    expect(remoteokJobOk(text, locationText, { ...baseCriteria, remote_ok: false, locations: [] })).toBe(true);
  });

  it("requires a location match when remote_ok is false and locations is set", () => {
    const text = "senior developer acme worldwide";
    const locationText = "worldwide";
    expect(
      remoteokJobOk(text, locationText, { ...baseCriteria, remote_ok: false, locations: ["United States"] })
    ).toBe(false);
  });

  it("keeps a job when remote_ok is false but the location text matches", () => {
    const text = "senior developer acme united states";
    const locationText = "united states";
    expect(
      remoteokJobOk(text, locationText, { ...baseCriteria, remote_ok: false, locations: ["United States"] })
    ).toBe(true);
  });

  it("rejects a job missing all required keywords", () => {
    const text = "product manager acme remote";
    const locationText = "remote";
    expect(
      remoteokJobOk(text, locationText, { ...baseCriteria, remote_ok: true, required_keywords: ["developer", "engineer"] })
    ).toBe(false);
  });

  it("keeps a job matching at least one required keyword", () => {
    const text = "senior engineer acme remote";
    const locationText = "remote";
    expect(
      remoteokJobOk(text, locationText, { ...baseCriteria, remote_ok: true, required_keywords: ["developer", "engineer"] })
    ).toBe(true);
  });

  it("rejects a job containing an excluded keyword", () => {
    const text = "unpaid internship acme remote";
    const locationText = "remote";
    expect(
      remoteokJobOk(text, locationText, { ...baseCriteria, remote_ok: true, excluded_keywords: ["internship"] })
    ).toBe(false);
  });

  it("keeps a job with no excluded keywords present", () => {
    const text = "senior developer acme remote";
    const locationText = "remote";
    expect(
      remoteokJobOk(text, locationText, { ...baseCriteria, remote_ok: true, excluded_keywords: ["internship"] })
    ).toBe(true);
  });
});
