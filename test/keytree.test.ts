// keytree.test.ts — the VKT1 envelope: round-trip, magic discrimination,
// wrong-passphrase behaviour, and version fencing.
//
// The magic-discrimination tests matter more than they look: a keytree and
// a .share are both passphrase-sealed blobs a user might mix up, and the
// failure has to name which one they handed over.

import { describe, expect, test } from "bun:test";
import {
  buildKeytreeFile,
  parseKeytreeFile,
  validateKeytreePayload,
  KEYTREE_VERSION,
  type KeytreePayload,
} from "../src/keytree";
import { buildShareFile } from "../src/sharefile";
import { EXPORT_BLOB_VERSION } from "../src/envconfig";

const sampleConfig = {
  version: 1 as const,
  s3: {
    endpoint: "https://s3.example.com",
    region: "eu-central-1",
    bucket: "vault-bucket",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "secret-example",
    useSsl: true,
  },
  encryption: { salt: "c2FsdHktc2FsdA==" },
  prefix: "dev/",
};

function payload(entries = 2): KeytreePayload {
  return {
    version: KEYTREE_VERSION,
    exportedAt: "2026-07-26T00:00:00.000Z",
    entries: Array.from({ length: entries }, (_, i) => ({
      repo: `acme_repo${i}`,
      env: "dev",
      config: sampleConfig,
      key: `key-material-${i}`,
    })),
    profiles: [],
  };
}

describe("keytree — round trip", () => {
  test("survives build → parse with the same passphrase", async () => {
    const bytes = await buildKeytreeFile(payload(3), "correct horse battery");
    const out = await parseKeytreeFile(bytes, "correct horse battery");

    expect(out.version).toBe(KEYTREE_VERSION);
    expect(out.entries.length).toBe(3);
    expect(out.entries[0]!.repo).toBe("acme_repo0");
    expect(out.entries[2]!.key).toBe("key-material-2");
    // config must survive intact — it's what makes import a one-step restore
    expect(out.entries[1]!.config.s3.bucket).toBe("vault-bucket");
  });

  test("carries the VKT1 magic", async () => {
    const bytes = await buildKeytreeFile(payload(1), "pw-whatever");
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x56, 0x4b, 0x54, 0x31]);
  });

  test("two exports of identical input differ (fresh salt each time)", async () => {
    const a = await buildKeytreeFile(payload(1), "same-pass");
    const b = await buildKeytreeFile(payload(1), "same-pass");
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  test("an empty selection still round-trips", async () => {
    const bytes = await buildKeytreeFile(
      { version: KEYTREE_VERSION, exportedAt: "2026-07-26T00:00:00.000Z", entries: [], profiles: [] },
      "pw-empty",
    );
    expect((await parseKeytreeFile(bytes, "pw-empty")).entries).toEqual([]);
  });
});

describe("keytree — failure paths", () => {
  test("wrong passphrase fails without leaking anything", async () => {
    const bytes = await buildKeytreeFile(payload(1), "right-passphrase");
    await expect(parseKeytreeFile(bytes, "wrong-passphrase")).rejects.toThrow(
      /passphrase wrong or file corrupt/,
    );
  });

  test("a .share file is rejected, and the error names the right verb", async () => {
    const share = await buildShareFile(
      {
        version: EXPORT_BLOB_VERSION,
        repo: "acme_web",
        env: "dev",
        config: sampleConfig,
        // share-file validation requires >= 20 chars; use a realistic key
        key: "dorrU1NnkndNEZu4xgM/jv/ECA4xMjJ3vl70wKPDtvY=",
      },
      "share-pass",
    );
    await expect(parseKeytreeFile(share, "share-pass")).rejects.toThrow(
      /not a vsync keytree file[\s\S]*vsync import/,
    );
  });

  test("truncated file is rejected, not silently half-read", async () => {
    const bytes = await buildKeytreeFile(payload(1), "pw");
    await expect(parseKeytreeFile(bytes.subarray(0, 3), "pw")).rejects.toThrow(
      /too short/,
    );
  });

  test("build refuses an unsupported payload version", async () => {
    await expect(
      buildKeytreeFile({ ...payload(1), version: 99 }, "pw"),
    ).rejects.toThrow(/not supported/);
  });

  test("build refuses an empty passphrase", async () => {
    await expect(buildKeytreeFile(payload(1), "")).rejects.toThrow(
      /passphrase is required/,
    );
  });
});

describe("validateKeytreePayload", () => {
  test("a future version is fenced with an actionable message", () => {
    expect(() =>
      validateKeytreePayload({ version: 99, exportedAt: "", entries: [], profiles: [] }),
    ).toThrow(/not supported by this vsync/);
  });

  test("entries missing key material are rejected", () => {
    expect(() =>
      validateKeytreePayload({
        version: KEYTREE_VERSION,
        exportedAt: "",
        entries: [{ repo: "r", env: "dev", config: sampleConfig }],
        profiles: [],
      }),
    ).toThrow(/missing key/);
  });

  test("non-object payloads are rejected", () => {
    expect(() => validateKeytreePayload(null)).toThrow(/not an object/);
    expect(() => validateKeytreePayload("nope")).toThrow(/not an object/);
  });

  test("a payload without profiles[] is rejected", () => {
    expect(() =>
      validateKeytreePayload({
        version: KEYTREE_VERSION,
        exportedAt: "",
        entries: [],
      }),
    ).toThrow(/no profiles\[\]/);
  });

  test("malformed profiles are rejected", () => {
    expect(() =>
      validateKeytreePayload({
        version: KEYTREE_VERSION,
        exportedAt: "",
        entries: [],
        profiles: [{ name: "myprofile" }],
      }),
    ).toThrow(/missing bucket/);
  });
});

// Found by stress test: a structurally-plausible entry whose config was NOT a
// valid ConfigFile passed parse, then threw partway through the import loop —
// leaving the machine half-restored (entry 1 written, entry 3 never reached).
// Validation must reject the whole file before any write happens.
describe("keytree — all-or-nothing validation", () => {
  test("an entry with a plausible-but-invalid config is rejected at parse", async () => {
    const bad: KeytreePayload = {
      ...payload(1),
      entries: [
        { repo: "aaa_first", env: "dev", config: sampleConfig, key: "k1-aaaaaaaaaaaaaaaaaaaa" },
        {
          repo: "bbb_broken",
          env: "dev",
          config: { nonsense: true } as never,
          key: "k2-aaaaaaaaaaaaaaaaaaaa",
        },
      ],
    };
    const bytes = await buildKeytreeFile(bad, "pw-partial");
    await expect(parseKeytreeFile(bytes, "pw-partial")).rejects.toThrow(
      /bbb_broken\/dev has an invalid config/,
    );
  });

  test("a profile missing credentials is rejected at parse", async () => {
    const bad: KeytreePayload = {
      ...payload(1),
      profiles: [{ name: "broken", bucket: "b" } as never],
    };
    const bytes = await buildKeytreeFile(bad, "pw-profile");
    await expect(parseKeytreeFile(bytes, "pw-profile")).rejects.toThrow(
      /profile broken is invalid/,
    );
  });
});

describe("keytree — profiles round trip", () => {
  // Profiles are what make a restored machine able to `vsync init` a NEW env;
  // configs + keys alone only revive the envs that already existed.
  test("profiles survive build → parse with credentials intact", async () => {
    const withProfiles: KeytreePayload = {
      ...payload(1),
      profiles: [
        {
          name: "myprofile",
          version: 1,
          endpoint: "https://s3.example.com",
          region: "eu-central-1",
          bucket: "vault-bucket",
          prefix: "myapp/",
          accessKeyId: "AKIAEXAMPLE",
          secretAccessKey: "secret-example",
        },
      ],
    };
    const out = await parseKeytreeFile(
      await buildKeytreeFile(withProfiles, "pw-profiles"),
      "pw-profiles",
    );
    expect(out.profiles.length).toBe(1);
    expect(out.profiles[0]!.name).toBe("myprofile");
    expect(out.profiles[0]!.bucket).toBe("vault-bucket");
    expect(out.profiles[0]!.secretAccessKey).toBe("secret-example");
  });
});
