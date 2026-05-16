import { test, expect, describe, beforeEach } from "bun:test";
import {
  AUDIT_HEADER,
  AuditHttpError,
  auditKey,
  appendAuditRow,
  buildMeta,
  formatAuditCsv,
  formatAuditTable,
  gatherRowMetadata,
  parseAuditCsv,
  readAuditLog,
  rowToCsv,
  type AuditClient,
  type AuditRow,
} from "../src/audit";

// --------------------------------------------------------------------------
// path helper

describe("auditKey", () => {
  test("lowercases env and joins repo/env/audit.csv", () => {
    expect(auditKey("acme", "DEV")).toBe("acme/dev/audit.csv");
  });

  test("rejects empty repo or env", () => {
    expect(() => auditKey("", "dev")).toThrow(/repo/);
    expect(() => auditKey("acme", "")).toThrow(/env/);
  });
});

// --------------------------------------------------------------------------
// CSV round-trip (RFC 4180)

function sampleRow(over: Partial<AuditRow> = {}): AuditRow {
  return {
    ts: "2026-05-16T01:00:00.000Z",
    action: "push",
    version_ts: "20260516-010000",
    hostname: "host-1",
    local_ip: "10.0.0.5",
    os_user: "muthu",
    git_email: "muthu@example.com",
    vsync_version: "0.4.0",
    bun_version: "1.3.0",
    meta: "",
    ...over,
  };
}

describe("CSV round-trip", () => {
  test("plain row → serialize → parse → same row", () => {
    const r = sampleRow();
    const csv = AUDIT_HEADER + "\n" + rowToCsv(r) + "\n";
    const parsed = parseAuditCsv(csv);
    expect(parsed).toEqual([r]);
  });

  test("RFC 4180: values with comma, quote, newline survive round-trip", () => {
    const meta = JSON.stringify({
      note: 'hot, "fixed" with\nmulti-line',
      ticket: "FOO-1,2",
    });
    const r = sampleRow({ meta });
    const csv = AUDIT_HEADER + "\n" + rowToCsv(r) + "\n";
    expect(csv).toContain('""'); // doubled quotes inside cell
    const parsed = parseAuditCsv(csv);
    expect(parsed[0].meta).toBe(meta);
  });

  test("multiple rows round-trip", () => {
    const rows = [
      sampleRow({ action: "pull", ts: "2026-05-16T00:00:00.000Z" }),
      sampleRow({ action: "push", ts: "2026-05-16T01:00:00.000Z", meta: '{"note":"x"}' }),
    ];
    const csv = formatAuditCsv(rows);
    expect(parseAuditCsv(csv)).toEqual(rows);
  });

  test("empty meta cell stays empty (not the literal {})", () => {
    const r = sampleRow({ meta: "" });
    const csv = AUDIT_HEADER + "\n" + rowToCsv(r) + "\n";
    expect(parseAuditCsv(csv)[0].meta).toBe("");
  });
});

// --------------------------------------------------------------------------
// buildMeta (spec §4.1)

describe("buildMeta", () => {
  test("returns empty string when nothing supplied", () => {
    const r = buildMeta({});
    expect(r.json).toBe("");
    expect(r.warnings).toEqual([]);
  });

  test("priority: env META < env NOTE < --meta < --note", () => {
    // Reproduces the spec §4.1 CI example, with --note overriding to test
    // that --note (last) wins over an earlier note source.
    const r = buildMeta({
      envMeta: '{"run_id":"7891234","commit":"abc123"}',
      envNote: "prod deploy",
      flagMetaList: ["ticket=BUG-42"],
    });
    expect(r.warnings).toEqual([]);
    expect(JSON.parse(r.json)).toEqual({
      run_id: "7891234",
      commit: "abc123",
      note: "prod deploy",
      ticket: "BUG-42",
    });
  });

  test("--note overrides $VSYNC_AUDIT_NOTE", () => {
    const r = buildMeta({ envNote: "from env", flagNote: "from flag" });
    expect(JSON.parse(r.json).note).toBe("from flag");
  });

  test("--meta last-write-wins on repeated keys", () => {
    const r = buildMeta({
      flagMetaList: ["k=v1", "k=v2", "k=v3"],
    });
    expect(JSON.parse(r.json)).toEqual({ k: "v3" });
  });

  test("--meta splits on first =, value can contain more =", () => {
    const r = buildMeta({ flagMetaList: ["k=val=ue=more"] });
    expect(JSON.parse(r.json)).toEqual({ k: "val=ue=more" });
  });

  test("--meta with no = is a usage error", () => {
    expect(() => buildMeta({ flagMetaList: ["justakey"] })).toThrow(/key=value/);
  });

  test("size cap: >2KB → {_truncated: true} + warning", () => {
    const big = "x".repeat(3000);
    const r = buildMeta({ flagMetaList: [`note=${big}`] });
    expect(JSON.parse(r.json)).toEqual({ _truncated: true });
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/2048/);
  });

  test("invalid envMeta JSON → warning, that source ignored, others apply", () => {
    const r = buildMeta({
      envMeta: "{not-json",
      envNote: "stillhere",
      flagNote: "winning",
    });
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/VSYNC_AUDIT_META/);
    expect(JSON.parse(r.json)).toEqual({ note: "winning" });
  });

  test("envMeta that isn't a JSON object → warning, ignored", () => {
    const r = buildMeta({ envMeta: '"just-a-string"' });
    expect(r.warnings[0]).toMatch(/not a JSON object/);
    expect(r.json).toBe("");
  });

  test("envMeta non-string values are stringified", () => {
    const r = buildMeta({ envMeta: '{"run_id":7891234,"flag":true}' });
    expect(JSON.parse(r.json)).toEqual({
      run_id: "7891234",
      flag: "true",
    });
  });
});

// --------------------------------------------------------------------------
// gatherRowMetadata

describe("gatherRowMetadata", () => {
  test("fills hostname, os_user, vsync_version, bun_version", async () => {
    const row = await gatherRowMetadata("pull", "20260516-010000");
    expect(row.action).toBe("pull");
    expect(row.version_ts).toBe("20260516-010000");
    expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO 8601
    expect(row.hostname.length).toBeGreaterThan(0);
    expect(row.bun_version).toBe(process.versions.bun ?? "");
    expect(row.vsync_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(row.meta).toBe(""); // caller fills via buildMeta
  });

  test("version_ts defaults to empty for import/export", async () => {
    const row = await gatherRowMetadata("import");
    expect(row.version_ts).toBe("");
  });
});

// --------------------------------------------------------------------------
// formatAuditTable

describe("formatAuditTable", () => {
  test("newest first, respects limit, surfaces meta.note", () => {
    const rows: AuditRow[] = [
      sampleRow({ ts: "2026-05-16T00:00:00.000Z", action: "push", meta: '{"note":"early"}' }),
      sampleRow({ ts: "2026-05-16T02:00:00.000Z", action: "pull", meta: '{"note":"late","ticket":"X"}' }),
      sampleRow({ ts: "2026-05-16T01:00:00.000Z", action: "import" }),
    ];
    const out = formatAuditTable(rows, { limit: 2 });
    const lines = out.split("\n");
    // header + separator + 2 body rows + footer line
    expect(lines[0]).toMatch(/TS\s+ACTION/);
    expect(lines[2]).toContain("pull"); // newest
    expect(lines[3]).toContain("import"); // 2nd newest
    expect(out).toContain("late"); // note column
    expect(out).toContain("ticket=X"); // collapsed meta summary
    expect(out).toMatch(/1 older row not shown/);
  });

  test("all=true ignores limit", () => {
    const rows: AuditRow[] = Array.from({ length: 5 }, (_, i) =>
      sampleRow({ ts: `2026-05-16T0${i}:00:00.000Z`, action: "push" }),
    );
    const out = formatAuditTable(rows, { limit: 2, all: true });
    expect(out).not.toMatch(/older row/);
    // 5 body rows expected
    expect(out.split("\n").length).toBe(2 + 5);
  });

  test("empty rows returns a friendly message", () => {
    expect(formatAuditTable([])).toBe("(no rows)");
  });
});

// --------------------------------------------------------------------------
// Network-touching: appendAuditRow + readAuditLog with a fake client

class FakeClient implements AuditClient {
  store = new Map<string, { text: string; etag: string }>();
  calls: string[] = [];
  // Programmable: queue of behaviours per put-call (consumed in order)
  putBehavior: Array<"ok" | "412-then-update" | "403" | "500"> = [];
  // Programmable: queue of read overrides
  readBehavior: Array<"throw-403" | "throw-500"> = [];
  etagSeq = 0;

  async read(key: string) {
    this.calls.push(`read(${key})`);
    if (this.readBehavior.length > 0) {
      const b = this.readBehavior.shift()!;
      if (b === "throw-403") throw new AuditHttpError(403, "denied");
      if (b === "throw-500") throw new AuditHttpError(500, "boom");
    }
    return this.store.get(key) ?? null;
  }

  async conditionalPut(
    key: string,
    body: string,
    condition: { ifMatch?: string; ifNoneMatch?: string },
  ) {
    const behavior = this.putBehavior.shift() ?? "ok";
    this.calls.push(
      `put(${key}, ifMatch=${condition.ifMatch ?? ""}, ifNoneMatch=${condition.ifNoneMatch ?? ""})`,
    );
    if (behavior === "403") throw new AuditHttpError(403, "denied");
    if (behavior === "500") throw new AuditHttpError(500, "boom");
    if (behavior === "412-then-update") {
      // Simulate a competing writer winning: rewrite stored content,
      // bump the ETag, then signal Precondition Failed.
      this.etagSeq++;
      this.store.set(key, {
        text: (this.store.get(key)?.text ?? "") + "x,competing\n",
        etag: `etag-${this.etagSeq}`,
      });
      throw new AuditHttpError(412, "etag mismatch");
    }
    // Success — check precondition matches what's stored
    const cur = this.store.get(key);
    if (condition.ifNoneMatch === "*" && cur) {
      throw new AuditHttpError(412, "object already exists");
    }
    if (condition.ifMatch && cur?.etag !== condition.ifMatch) {
      throw new AuditHttpError(412, "etag mismatch");
    }
    this.etagSeq++;
    this.store.set(key, { text: body, etag: `etag-${this.etagSeq}` });
  }
}

describe("appendAuditRow", () => {
  let client: FakeClient;
  beforeEach(() => {
    client = new FakeClient();
  });

  test("first write creates header + row with If-None-Match: *", async () => {
    const row = sampleRow({ action: "push" });
    await appendAuditRow(client, "acme", "dev", row);
    const stored = client.store.get("acme/dev/audit.csv")!;
    expect(stored.text).toBe(AUDIT_HEADER + "\n" + rowToCsv(row) + "\n");
    expect(client.calls[1]).toContain("ifNoneMatch=*");
  });

  test("append-after-existing uses If-Match: <etag>", async () => {
    const r1 = sampleRow({ action: "push", ts: "2026-05-16T00:00:00.000Z" });
    await appendAuditRow(client, "acme", "dev", r1);
    const etagBefore = client.store.get("acme/dev/audit.csv")!.etag;

    const r2 = sampleRow({ action: "pull", ts: "2026-05-16T01:00:00.000Z" });
    await appendAuditRow(client, "acme", "dev", r2);
    const stored = client.store.get("acme/dev/audit.csv")!;
    expect(stored.text).toBe(
      AUDIT_HEADER + "\n" + rowToCsv(r1) + "\n" + rowToCsv(r2) + "\n",
    );
    expect(client.calls).toContainEqual(
      expect.stringContaining(`ifMatch=${etagBefore}`),
    );
  });

  test("412 conflict retries up to 3 times then succeeds", async () => {
    const r1 = sampleRow({ action: "push" });
    await appendAuditRow(client, "acme", "dev", r1); // seed

    // Next put fails with 412 once, then succeeds
    client.putBehavior = ["412-then-update", "ok"];
    const r2 = sampleRow({ action: "pull", ts: "2026-05-16T02:00:00.000Z" });
    await appendAuditRow(client, "acme", "dev", r2);

    const text = client.store.get("acme/dev/audit.csv")!.text;
    expect(text).toContain("x,competing"); // competitor's row preserved
    expect(text).toContain(rowToCsv(r2)); // our row appended on retry
  });

  test("403 on read → silent skip (no throw, no put)", async () => {
    client.readBehavior = ["throw-403"];
    const r = sampleRow();
    await appendAuditRow(client, "acme", "dev", r);
    // No put happened
    expect(client.calls.some((c) => c.startsWith("put("))).toBe(false);
  });

  test("403 on put → silent skip", async () => {
    client.putBehavior = ["403"];
    const r = sampleRow();
    await appendAuditRow(client, "acme", "dev", r);
    expect(client.store.has("acme/dev/audit.csv")).toBe(false);
  });

  test("persistent 412 (3 attempts) throws", async () => {
    await appendAuditRow(client, "acme", "dev", sampleRow()); // seed
    client.putBehavior = ["412-then-update", "412-then-update", "412-then-update"];
    await expect(
      appendAuditRow(client, "acme", "dev", sampleRow({ action: "pull" })),
    ).rejects.toThrow(/etag mismatch|412|conflict|giving up/i);
  });

  test("non-403/412 errors (e.g. 500) propagate", async () => {
    client.putBehavior = ["500"];
    await expect(
      appendAuditRow(client, "acme", "dev", sampleRow()),
    ).rejects.toThrow(/boom/);
  });
});

describe("readAuditLog", () => {
  test("returns [] when the object doesn't exist", async () => {
    const client = new FakeClient();
    expect(await readAuditLog(client, "acme", "dev")).toEqual([]);
  });

  test("returns parsed rows when present", async () => {
    const client = new FakeClient();
    await appendAuditRow(client, "acme", "dev", sampleRow({ action: "push" }));
    await appendAuditRow(client, "acme", "dev", sampleRow({ action: "pull", ts: "2026-05-16T03:00:00.000Z" }));
    const rows = await readAuditLog(client, "acme", "dev");
    expect(rows.length).toBe(2);
    expect(rows[0].action).toBe("push");
    expect(rows[1].action).toBe("pull");
  });
});
