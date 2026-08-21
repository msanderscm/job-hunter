import { describe, it, expect } from "vitest";
import {
  cosineSimilarity,
  encodeEmbedding,
  decodeEmbedding,
  companyKey,
  jobEmbeddingText,
  findDuplicate,
  EMBED_MAX_CHARS,
  DUPLICATE_THRESHOLD,
} from "./dedupe";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1, 6);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 6);
  });

  it("returns -1 for opposite vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([-1, -2, -3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 6);
  });

  it("returns 0 when either vector is a zero vector", () => {
    const zero = new Float32Array([0, 0, 0]);
    const other = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(zero, other)).toBe(0);
    expect(cosineSimilarity(other, zero)).toBe(0);
    expect(cosineSimilarity(zero, zero)).toBe(0);
  });

  it("throws on length mismatch", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([1, 2]);
    expect(() => cosineSimilarity(a, b)).toThrow();
  });
});

describe("encodeEmbedding / decodeEmbedding", () => {
  it("round-trips a Float32Array including negative/fractional values", () => {
    const original = new Float32Array([1.5, -2.25, 0, -0.001, 3.14159]);
    const buffer = encodeEmbedding(original);
    const decoded = decodeEmbedding(buffer);
    expect(decoded.length).toBe(original.length);
    for (let i = 0; i < original.length; i += 1) {
      expect(decoded[i]).toBeCloseTo(original[i], 5);
    }
  });

  it("byte length is 4 times the vector length", () => {
    const vec = new Float32Array([1, 2, 3, 4, 5]);
    const buffer = encodeEmbedding(vec);
    expect(buffer.byteLength).toBe(vec.length * 4);
  });

  it("decodes from a Uint8Array", () => {
    const original = new Float32Array([1, -1, 0.5]);
    const buffer = encodeEmbedding(original);
    const bytes = new Uint8Array(buffer);
    const decoded = decodeEmbedding(bytes);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it("decodes from a number[]", () => {
    const original = new Float32Array([1, -1, 0.5]);
    const buffer = encodeEmbedding(original);
    const asNumberArray = Array.from(new Uint8Array(buffer));
    const decoded = decodeEmbedding(asNumberArray);
    expect(Array.from(decoded)).toEqual(Array.from(original));
  });

  it("writes bytes in little-endian order for a known value", () => {
    // 1.0 as float32 little-endian is 00 00 80 3f
    const buffer = encodeEmbedding(new Float32Array([1.0]));
    const bytes = new Uint8Array(buffer);
    expect(Array.from(bytes)).toEqual([0x00, 0x00, 0x80, 0x3f]);
  });
});

describe("companyKey", () => {
  it("normalises case, whitespace, and punctuation", () => {
    expect(companyKey("  Acme,   Corp!!  ")).toBe(companyKey("acme corp"));
  });

  it("strips a trailing legal suffix so equivalent names match", () => {
    expect(companyKey("Acme, Inc.")).toBe(companyKey("ACME inc"));
  });

  it("does not strip a non-suffix trailing word", () => {
    const key = companyKey("Acme Widgets");
    expect(key).toBe("acme widgets");
    expect(key).not.toBe("acme");
  });
});

describe("jobEmbeddingText", () => {
  it("joins title, company, location, description in order with newlines", () => {
    const text = jobEmbeddingText({
      title: "Engineer",
      company: "Acme",
      location: "Remote",
      description: "Build things.",
    });
    expect(text).toBe("Engineer\nAcme\nRemote\nBuild things.");
  });

  it("treats null location and description as empty strings", () => {
    const text = jobEmbeddingText({
      title: "Engineer",
      company: "Acme",
      location: null,
      description: null,
    });
    // The trailing "\n\n" from the empty location/description is removed by
    // the final trim() — only leading/trailing whitespace is affected.
    expect(text).toBe("Engineer\nAcme");
  });

  it("truncates to EMBED_MAX_CHARS", () => {
    const longDescription = "x".repeat(EMBED_MAX_CHARS + 500);
    const text = jobEmbeddingText({
      title: "Engineer",
      company: "Acme",
      location: null,
      description: longDescription,
    });
    expect(text.length).toBe(EMBED_MAX_CHARS);
  });
});

describe("findDuplicate", () => {
  const candidate = { company: "Acme, Inc.", embedding: new Float32Array([1, 0, 0]) };

  it("returns null for an empty pool", () => {
    expect(findDuplicate(candidate, [])).toBeNull();
  });

  it("ignores pool entries with a different companyKey even at similarity 1", () => {
    const pool = [{ id: "other-co", company: "Widgets LLC", embedding: new Float32Array([1, 0, 0]) }];
    expect(findDuplicate(candidate, pool)).toBeNull();
  });

  it("returns the best match among several same-company entries", () => {
    const pool = [
      { id: "low", company: "Acme", embedding: new Float32Array([0, 1, 0]) },
      { id: "best", company: "Acme", embedding: new Float32Array([1, 0, 0]) },
      { id: "mid", company: "Acme", embedding: new Float32Array([0.9, 0.1, 0]) },
    ];
    const result = findDuplicate(candidate, pool);
    expect(result).not.toBeNull();
    expect(result?.id).toBe("best");
    expect(result?.similarity).toBeCloseTo(1, 6);
  });

  it("returns null just below DUPLICATE_THRESHOLD", () => {
    // Construct a vector whose cosine similarity to [1,0,0] is just under the threshold.
    const angleBelow = Math.acos(DUPLICATE_THRESHOLD - 0.01);
    const vec = new Float32Array([Math.cos(angleBelow), Math.sin(angleBelow), 0]);
    const pool = [{ id: "close-but-no", company: "Acme", embedding: vec }];
    expect(findDuplicate(candidate, pool)).toBeNull();
  });

  it("returns a match at/above DUPLICATE_THRESHOLD", () => {
    // Pick a cosine comfortably above the threshold rather than the exact
    // boundary value, since storing it in a Float32Array can round either
    // direction and make an exact-boundary case flaky.
    const angleAt = Math.acos(DUPLICATE_THRESHOLD + 0.01);
    const vec = new Float32Array([Math.cos(angleAt), Math.sin(angleAt), 0]);
    const pool = [{ id: "just-enough", company: "Acme", embedding: vec }];
    const result = findDuplicate(candidate, pool);
    expect(result).not.toBeNull();
    expect(result?.id).toBe("just-enough");
    expect(result?.similarity).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
  });

  it("never deduplicates a candidate with a placeholder company, even against an identical vector", () => {
    const identicalPoolEntry = (company: string) => [
      { id: "identical", company, embedding: new Float32Array([1, 0, 0]) },
    ];

    expect(
      findDuplicate({ company: "Unknown", embedding: new Float32Array([1, 0, 0]) }, identicalPoolEntry("Unknown"))
    ).toBeNull();
    expect(
      findDuplicate({ company: "N/A", embedding: new Float32Array([1, 0, 0]) }, identicalPoolEntry("N/A"))
    ).toBeNull();
    expect(
      findDuplicate({ company: "", embedding: new Float32Array([1, 0, 0]) }, identicalPoolEntry(""))
    ).toBeNull();
  });

  it("still matches a candidate with a real company name", () => {
    const pool = [{ id: "real-match", company: "Acme", embedding: new Float32Array([1, 0, 0]) }];
    const result = findDuplicate(candidate, pool);
    expect(result).not.toBeNull();
    expect(result?.id).toBe("real-match");
  });

  it("skips pool entries with a length mismatch without throwing", () => {
    const pool = [
      { id: "mismatched", company: "Acme", embedding: new Float32Array([1, 0]) },
      { id: "matches", company: "Acme", embedding: new Float32Array([1, 0, 0]) },
    ];
    let result: ReturnType<typeof findDuplicate> = null;
    expect(() => {
      result = findDuplicate(candidate, pool);
    }).not.toThrow();
    expect(result).not.toBeNull();
    expect((result as { id: string; similarity: number } | null)?.id).toBe("matches");
  });
});
