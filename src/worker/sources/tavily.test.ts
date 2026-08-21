import { describe, it, expect } from "vitest";
import { companyFromListingUrl, normalizeListingUrl } from "./tavily";

describe("companyFromListingUrl", () => {
  it("extracts the company slug from a Greenhouse boards URL", () => {
    expect(companyFromListingUrl("https://boards.greenhouse.io/acme/jobs/12345")).toBe("acme");
  });

  it("extracts the company slug from a job-boards.greenhouse.io URL", () => {
    expect(companyFromListingUrl("https://job-boards.greenhouse.io/acme-corp/jobs/12345")).toBe("acme-corp");
  });

  it("extracts the company slug from a Lever URL", () => {
    expect(companyFromListingUrl("https://jobs.lever.co/acme/abcd-1234")).toBe("acme");
  });

  it("extracts the company slug from an Ashby URL", () => {
    expect(companyFromListingUrl("https://jobs.ashbyhq.com/acme/opening-1")).toBe("acme");
  });

  it("extracts the company slug from a Workable URL", () => {
    expect(companyFromListingUrl("https://apply.workable.com/acme/j/ABCDEF/")).toBe("acme");
  });

  it("decodes percent-encoded slugs", () => {
    expect(companyFromListingUrl("https://boards.greenhouse.io/acme%20corp/jobs/1")).toBe("acme corp");
  });

  it("returns Unknown for unrecognized hosts", () => {
    expect(companyFromListingUrl("https://example.com/careers/acme")).toBe("Unknown");
  });

  it("returns Unknown for a known host with no path segment", () => {
    expect(companyFromListingUrl("https://boards.greenhouse.io/")).toBe("Unknown");
  });

  it("returns Unknown for an unparseable URL", () => {
    expect(companyFromListingUrl("not a url")).toBe("Unknown");
  });
});

describe("normalizeListingUrl", () => {
  it("forces http to https", () => {
    expect(normalizeListingUrl("http://jobs.lever.co/veeva/abcd-1234")).toBe("https://jobs.lever.co/veeva/abcd-1234");
  });

  it("strips query string and hash", () => {
    expect(normalizeListingUrl("https://jobs.lever.co/veeva/abcd-1234?ref=foo#section")).toBe(
      "https://jobs.lever.co/veeva/abcd-1234",
    );
  });

  it("removes a trailing /apply segment", () => {
    expect(normalizeListingUrl("https://jobs.lever.co/veeva/abcd-1234/apply")).toBe(
      "https://jobs.lever.co/veeva/abcd-1234",
    );
  });

  it("removes a trailing /apply segment with a trailing slash", () => {
    expect(normalizeListingUrl("https://jobs.lever.co/veeva/abcd-1234/apply/")).toBe(
      "https://jobs.lever.co/veeva/abcd-1234",
    );
  });

  it("removes a trailing /apply segment with a query string (live example)", () => {
    expect(normalizeListingUrl("https://jobs.lever.co/veeva/abcd-1234/apply?lever-origin=applied")).toBe(
      "https://jobs.lever.co/veeva/abcd-1234",
    );
  });

  it("leaves 'apply' untouched when it is not the last segment", () => {
    expect(normalizeListingUrl("https://example.com/apply/veeva/abcd-1234")).toBe(
      "https://example.com/apply/veeva/abcd-1234",
    );
  });

  it("lowercases the hostname", () => {
    expect(normalizeListingUrl("https://Jobs.Lever.co/veeva/abcd-1234")).toBe("https://jobs.lever.co/veeva/abcd-1234");
  });

  it("returns unparseable input unchanged", () => {
    expect(normalizeListingUrl("not a url")).toBe("not a url");
  });

  it("collapses a path that is just /apply to the bare host", () => {
    expect(normalizeListingUrl("https://jobs.lever.co/apply")).toBe("https://jobs.lever.co/");
  });
});
