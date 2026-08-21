import { describe, it, expect } from "vitest";
import {
  base64urlDecode,
  base64urlEncode,
  constantTimeEqual,
  hashPassword,
  normalizeUsername,
  PBKDF2_ITERATIONS,
  validateFirstName,
  validatePassword,
  validateUsername,
  verifyPassword,
} from "./password";

/** Keeps the suite fast — production hashes use PBKDF2_ITERATIONS. */
const TEST_ITERATIONS = 10_000;

describe("hashPassword / verifyPassword", () => {
  it("round-trips a password", async () => {
    const stored = await hashPassword("correct horse battery", TEST_ITERATIONS);
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
  });

  it("rejects the wrong password", async () => {
    const stored = await hashPassword("correct horse battery", TEST_ITERATIONS);
    expect(await verifyPassword("correct horse batterz", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("salts each hash, so the same password hashes differently", async () => {
    const a = await hashPassword("correct horse battery", TEST_ITERATIONS);
    const b = await hashPassword("correct horse battery", TEST_ITERATIONS);
    expect(a).not.toBe(b);
    expect(await verifyPassword("correct horse battery", b)).toBe(true);
  });

  it("records the iteration count it used and verifies with it", async () => {
    const stored = await hashPassword("correct horse battery", TEST_ITERATIONS);
    expect(stored.startsWith(`pbkdf2-sha256$${TEST_ITERATIONS}$`)).toBe(true);
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
  });

  it("refuses stored hashes below the iteration floor", async () => {
    // Written with 1,000 rounds — a downgraded row must never verify.
    const weak = await hashPassword("correct horse battery", 1000);
    expect(await verifyPassword("correct horse battery", weak)).toBe(false);
  });

  it("returns false for malformed stored strings", async () => {
    const good = await hashPassword("correct horse battery", TEST_ITERATIONS);
    const [, iterations, salt, hash] = good.split("$");

    const malformed = [
      "",
      "not-a-hash",
      good.replace("pbkdf2-sha256", "bcrypt"),
      `pbkdf2-sha256$${salt}$${hash}`,
      `pbkdf2-sha256$abc$${salt}$${hash}`,
      `pbkdf2-sha256$0$${salt}$${hash}`,
      `pbkdf2-sha256$2000000$${salt}$${hash}`,
      `pbkdf2-sha256$${iterations}$${salt}$${hash.slice(0, 10)}`,
      `pbkdf2-sha256$${iterations}$${salt}$not base64url!`,
      `pbkdf2-sha256$${iterations}$$${hash}`,
    ];

    for (const stored of malformed) {
      expect(await verifyPassword("correct horse battery", stored), stored).toBe(false);
    }
  });

  it("reports how long a production-strength hash takes", async () => {
    const started = Date.now();
    await hashPassword("x", PBKDF2_ITERATIONS);
    // Informational only: the Workers Free plan allows ~10 ms CPU per request.
    console.log(`hashPassword(${PBKDF2_ITERATIONS} iterations): ${Date.now() - started} ms`);
  });
});

describe("base64url", () => {
  it("round-trips arbitrary bytes without padding", () => {
    for (const length of [1, 2, 3, 16, 32]) {
      const bytes = new Uint8Array(length).map((_, i) => (i * 37) % 256);
      const encoded = base64urlEncode(bytes);
      expect(encoded).not.toContain("=");
      expect(Array.from(base64urlDecode(encoded) ?? [])).toEqual(Array.from(bytes));
    }
  });

  it("encodes the base64url alphabet, not base64", () => {
    const encoded = base64urlEncode(new Uint8Array([251, 255, 190]));
    expect(encoded).not.toMatch(/[+/=]/);
  });

  it("returns null for non-base64url input", () => {
    expect(base64urlDecode("")).toBeNull();
    expect(base64urlDecode("a b")).toBeNull();
    expect(base64urlDecode("abc+")).toBeNull();
    expect(base64urlDecode("abc=")).toBeNull();
  });
});

describe("constantTimeEqual", () => {
  it("is true for identical byte arrays", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(constantTimeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
  });

  it("is false for differing bytes", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });

  it("is false on a length mismatch", () => {
    expect(constantTimeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe("validateUsername", () => {
  it("accepts the allowed shape", () => {
    expect(validateUsername("tester")).toBeNull();
    expect(validateUsername("a.b_c-1")).toBeNull();
    expect(validateUsername("Tester ")).toBeNull();
    expect(validateUsername("a".repeat(32))).toBeNull();
  });

  it("rejects bad lengths, characters and types", () => {
    expect(validateUsername("ab")).not.toBeNull();
    expect(validateUsername("a".repeat(33))).not.toBeNull();
    expect(validateUsername("has space")).not.toBeNull();
    expect(validateUsername("has@sign")).not.toBeNull();
    expect(validateUsername("")).not.toBeNull();
    expect(validateUsername(123)).not.toBeNull();
    expect(validateUsername(null)).not.toBeNull();
    expect(validateUsername(undefined)).not.toBeNull();
  });
});

describe("normalizeUsername", () => {
  it("trims and lowercases", () => {
    expect(normalizeUsername("  Tester ")).toBe("tester");
    expect(normalizeUsername("ADMIN")).toBe("admin");
    expect(normalizeUsername("tester")).toBe("tester");
  });
});

describe("validatePassword", () => {
  it("accepts 10-128 characters", () => {
    expect(validatePassword("0123456789")).toBeNull();
    expect(validatePassword("x".repeat(128))).toBeNull();
  });

  it("rejects short, long and non-string values", () => {
    expect(validatePassword("123456789")).not.toBeNull();
    expect(validatePassword("x".repeat(129))).not.toBeNull();
    expect(validatePassword("")).not.toBeNull();
    expect(validatePassword(1234567890)).not.toBeNull();
    expect(validatePassword(undefined)).not.toBeNull();
  });
});

describe("validateFirstName", () => {
  it("accepts 1-60 trimmed characters", () => {
    expect(validateFirstName("Test")).toBeNull();
    expect(validateFirstName(" T ")).toBeNull();
    expect(validateFirstName("n".repeat(60))).toBeNull();
  });

  it("rejects blank, over-long and non-string values", () => {
    expect(validateFirstName("")).not.toBeNull();
    expect(validateFirstName("   ")).not.toBeNull();
    expect(validateFirstName("n".repeat(61))).not.toBeNull();
    expect(validateFirstName(null)).not.toBeNull();
  });
});
