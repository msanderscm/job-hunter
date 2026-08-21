import { describe, it, expect } from "vitest";
import { parseCookies, sameOrigin, sessionCookie, SESSION_TTL_SECONDS } from "./auth";

describe("parseCookies", () => {
  it("returns an empty map for a missing or empty header", () => {
    expect(parseCookies(null)).toEqual({});
    expect(parseCookies("")).toEqual({});
  });

  it("parses a single cookie", () => {
    expect(parseCookies("session=abc123")).toEqual({ session: "abc123" });
  });

  it("parses several cookies and trims the spacing", () => {
    expect(parseCookies("session=abc; theme=dark;other=1")).toEqual({
      session: "abc",
      theme: "dark",
      other: "1",
    });
  });

  it("keeps '=' inside a value", () => {
    expect(parseCookies("session=YWJj==; x=a=b")).toEqual({ session: "YWJj==", x: "a=b" });
  });

  it("skips malformed segments", () => {
    expect(parseCookies("novalue; =orphan; session=abc")).toEqual({ session: "abc" });
  });
});

describe("sessionCookie", () => {
  it("sets the hardening flags", () => {
    const cookie = sessionCookie("abc", new Request("http://localhost:8787/api/auth/login"), SESSION_TTL_SECONDS);
    expect(cookie).toContain("session=abc");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
  });

  it("omits Secure only for local hosts, regardless of scheme", () => {
    expect(sessionCookie("abc", new Request("http://localhost:8787/x"), 100)).not.toContain("Secure");
    expect(sessionCookie("abc", new Request("http://127.0.0.1:8787/x"), 100)).not.toContain("Secure");
    expect(sessionCookie("abc", new Request("https://example.com/x"), 100)).toContain("; Secure");
    expect(sessionCookie("abc", new Request("http://example.com/x"), 100)).toContain("; Secure");
  });

  it("clears with an empty value and Max-Age=0", () => {
    const cookie = sessionCookie("", new Request("http://localhost:8787/x"), 0);
    expect(cookie.startsWith("session=; ")).toBe(true);
    expect(cookie).toContain("Max-Age=0");
  });
});

describe("sameOrigin", () => {
  const url = "http://localhost:8787/api/auth/login";

  it("allows a request with no Origin or Sec-Fetch-Site (curl, scripts)", () => {
    expect(sameOrigin(new Request(url, { method: "POST" }))).toBe(true);
  });

  it("allows a matching Origin", () => {
    const request = new Request(url, {
      method: "POST",
      headers: { Origin: "http://localhost:8787", "Sec-Fetch-Site": "same-origin" },
    });
    expect(sameOrigin(request)).toBe(true);
  });

  it("rejects a foreign Origin", () => {
    const request = new Request(url, { method: "POST", headers: { Origin: "https://evil.example" } });
    expect(sameOrigin(request)).toBe(false);
  });

  it("rejects a cross-site Sec-Fetch-Site even without an Origin", () => {
    expect(sameOrigin(new Request(url, { method: "POST", headers: { "Sec-Fetch-Site": "cross-site" } }))).toBe(
      false
    );
    expect(sameOrigin(new Request(url, { method: "POST", headers: { "Sec-Fetch-Site": "same-site" } }))).toBe(
      false
    );
  });

  it("allows Sec-Fetch-Site: none (address-bar navigation)", () => {
    expect(sameOrigin(new Request(url, { method: "POST", headers: { "Sec-Fetch-Site": "none" } }))).toBe(true);
  });
});
