import { test, expect, describe } from "bun:test";
import {
  HANDBOOK_TOPICS,
  resolveTopic,
  renderTopicList,
} from "../src/templates/handbook";

describe("handbook topics", () => {
  test("every topic has a non-trivial body and a summary", () => {
    for (const t of HANDBOOK_TOPICS) {
      expect(t.body.length).toBeGreaterThanOrEqual(512);
      expect(t.body.split("\n")[0]).toMatch(/^#\s+/);
      expect(t.summary.length).toBeGreaterThan(0);
    }
  });

  test("topic keys are unique and don't collide with aliases", () => {
    const seen = new Set<string>();
    for (const t of HANDBOOK_TOPICS) {
      for (const name of [t.key, ...t.aliases]) {
        expect(seen.has(name)).toBe(false);
        seen.add(name);
      }
    }
  });

  for (const key of ["aws", "gcp", "custom", "agent"]) {
    test(`resolves canonical key "${key}"`, () => {
      expect(resolveTopic(key)?.key).toBe(key);
    });
  }

  for (const [alias, key] of [
    ["awss3", "aws"],
    ["gcps3", "gcp"],
    ["vps", "custom"],
    ["minio", "custom"],
    ["skill", "agent"],
    ["AGENT", "agent"], // case-insensitive
  ] as const) {
    test(`alias "${alias}" → "${key}"`, () => {
      expect(resolveTopic(alias)?.key).toBe(key);
    });
  }

  test("unknown topic resolves to undefined", () => {
    expect(resolveTopic("nope")).toBeUndefined();
  });
});

describe("provider runbook content", () => {
  // Each provider page must show how to create the bucket with the right CLI
  // and then the full vsync loop.
  const expectations: Record<string, string[]> = {
    aws: ["aws s3api create-bucket", "aws iam", "vsync profile add"],
    gcp: ["gcloud storage buckets create", "gcloud storage hmac", "vsync profile add"],
    custom: ["minio", "mc mb", "vsync profile add"],
  };

  for (const [key, needles] of Object.entries(expectations)) {
    const body = resolveTopic(key)!.body;
    for (const needle of needles) {
      test(`${key} runbook mentions "${needle}"`, () => {
        expect(body).toContain(needle);
      });
    }
    for (const cmd of ["vsync init", "vsync push", "vsync pull", "vsync use", "vsync sync", "vsync export", "vsync import"]) {
      test(`${key} runbook documents ${cmd}`, () => {
        expect(body).toContain(cmd);
      });
    }
  }
});

describe("agent workflow map", () => {
  const body = resolveTopic("agent")!.body;

  for (const cmd of [
    "vsync profile add",
    "vsync init",
    "vsync push",
    "vsync pull",
    "vsync use",
    "vsync sync",
    "vsync runtime-token",
    "vsync status",
  ]) {
    test(`mentions ${cmd}`, () => {
      expect(body).toContain(cmd);
    });
  }

  test("carries the different-channels rule", () => {
    expect(body).toMatch(/different channels/i);
  });

  test("states the engine boundary (does not reimplement)", () => {
    expect(body).toMatch(/engine/i);
  });
});

describe("renderTopicList", () => {
  test("lists every provider key and the agent topic", () => {
    const out = renderTopicList();
    for (const key of ["aws", "gcp", "custom", "agent"]) {
      expect(out).toContain(key);
    }
  });
});
