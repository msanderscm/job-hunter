import { describe, it, expect } from "vitest";
import {
  mergeMissingItems,
  parseMissingItems,
  parseResumeProfile,
  renderResumeProfile,
  RESUME_SUMMARY_MAX_CHARS,
} from "./resume-summary";

const sample = {
  profile: "Senior full-stack engineer, 15 years, SaaS and insurance.",
  technical_skills: ["React", "PHP", "Laravel", ".NET Core", "php", "  ", 42],
  tools: ["AWS Lambda", "RDS", "GitHub Actions"],
  roles: [
    { title: "Lead Engineer", company: "Acme", years: "2019-2024", scope: "Modernised a legacy insurance app." },
    { title: "", company: "", years: "", scope: "dropped" },
    "not an object",
  ],
  quantified_achievements: ["Cut deploy time 80%"],
};

describe("parseResumeProfile", () => {
  it("accepts a parsed object and normalises lists", () => {
    const p = parseResumeProfile(sample);
    expect(p).not.toBeNull();
    expect(p!.technical_skills).toEqual(["React", "PHP", "Laravel", ".NET Core"]); // dedupe case-insensitively, drop blanks/non-strings
    expect(p!.roles).toHaveLength(1);
    expect(p!.roles[0].company).toBe("Acme");
  });

  it("accepts a JSON string, including a fenced one", () => {
    const fenced = "```json\n" + JSON.stringify(sample) + "\n```";
    expect(parseResumeProfile(JSON.stringify(sample))?.tools).toEqual(sample.tools);
    expect(parseResumeProfile(fenced)?.tools).toEqual(sample.tools);
  });

  it("returns null for garbage or an empty profile", () => {
    expect(parseResumeProfile("not json")).toBeNull();
    expect(parseResumeProfile(null)).toBeNull();
    expect(parseResumeProfile({ profile: "", technical_skills: [], tools: [], roles: [], quantified_achievements: [] })).toBeNull();
  });

  it("tolerates missing fields", () => {
    const p = parseResumeProfile({ technical_skills: ["Go"] });
    expect(p?.technical_skills).toEqual(["Go"]);
    expect(p?.roles).toEqual([]);
    expect(p?.profile).toBe("");
  });
});

describe("renderResumeProfile", () => {
  it("renders the five headings in order with one bullet per item", () => {
    const text = renderResumeProfile(parseResumeProfile(sample)!);
    const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(["Profile", "Technical skills", "Tools", "Roles", "Quantified achievements"]);
    expect(text).toContain("- Laravel");
    expect(text).toContain("- PHP");
    expect(text).toContain("- Lead Engineer @ Acme (2019-2024) — Modernised a legacy insurance app.");
    expect(text).toContain("- Cut deploy time 80%");
  });

  it("marks empty sections instead of dropping the heading", () => {
    const text = renderResumeProfile(parseResumeProfile({ technical_skills: ["Go"] })!);
    expect(text).toContain("## Tools\n- (none listed)");
    expect(text).toContain("## Profile\n(not stated)");
  });

  it("caps the rendered length", () => {
    const huge = { technical_skills: Array.from({ length: 120 }, (_, i) => `Tech-${i}-${"x".repeat(200)}`) };
    const text = renderResumeProfile(parseResumeProfile(huge)!);
    expect(text.length).toBeLessThanOrEqual(RESUME_SUMMARY_MAX_CHARS);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("mergeMissingItems", () => {
  const resume = "Built a SaaS combining a React frontend, PHP / Laravel APIs and .NET Core APIs. Configured AWS lambdas, RDS databases, and DevOps.";
  const base = parseResumeProfile({ technical_skills: ["React", ".NET Core"], tools: ["RDS"] })!;

  it("adds items that literally occur in the resume and drops ones that don't", () => {
    const merged = mergeMissingItems(
      base,
      { missing_technical_skills: ["PHP", "Laravel", "Kubernetes"], missing_tools: ["AWS Lambdas", "Terraform"] },
      resume
    );
    expect(merged.technical_skills).toEqual(["React", ".NET Core", "PHP", "Laravel"]);
    expect(merged.tools).toEqual(["RDS", "AWS Lambdas"]);
  });

  it("matches case-insensitively and never duplicates existing items", () => {
    const merged = mergeMissingItems(base, { missing_technical_skills: ["react", "laravel"], missing_tools: ["rds"] }, resume);
    expect(merged.technical_skills).toEqual(["React", ".NET Core", "laravel"]);
    expect(merged.tools).toEqual(["RDS"]);
  });

  it("leaves roles and achievements untouched", () => {
    const merged = mergeMissingItems(base, { missing_technical_skills: [], missing_tools: [] }, resume);
    expect(merged).toEqual(base);
  });
});

describe("parseMissingItems", () => {
  it("parses objects and fenced strings, tolerating missing fields", () => {
    expect(parseMissingItems({ missing_technical_skills: ["Go"] })).toEqual({ missing_technical_skills: ["Go"], missing_tools: [] });
    expect(parseMissingItems('```json\n{"missing_technical_skills":[],"missing_tools":["Jira"]}\n```')?.missing_tools).toEqual(["Jira"]);
    expect(parseMissingItems("nope")).toBeNull();
  });
});
