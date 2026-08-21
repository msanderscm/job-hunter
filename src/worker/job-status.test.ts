import { describe, it, expect } from "vitest";
import { parseJobStatus } from "./api";

describe("parseJobStatus", () => {
  it("accepts each valid status", () => {
    expect(parseJobStatus("new")).toBe("new");
    expect(parseJobStatus("saved")).toBe("saved");
    expect(parseJobStatus("deleted")).toBe("deleted");
  });

  it("rejects a value of the wrong type", () => {
    expect(parseJobStatus(1)).toBeNull();
    expect(parseJobStatus(true)).toBeNull();
    expect(parseJobStatus(undefined)).toBeNull();
    expect(parseJobStatus({})).toBeNull();
    expect(parseJobStatus(["saved"])).toBeNull();
  });

  it("rejects an unknown string", () => {
    expect(parseJobStatus("bogus")).toBeNull();
    expect(parseJobStatus("Saved")).toBeNull();
    expect(parseJobStatus("")).toBeNull();
  });

  it("rejects null", () => {
    expect(parseJobStatus(null)).toBeNull();
  });
});
