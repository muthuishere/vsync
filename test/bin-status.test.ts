import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  renderStatusText,
  renderStatusJson,
  main,
} from "../bin/status";
import type { StatusReport } from "../src/status";
import { saveConfigFile, type ConfigFile } from "../src/repoconfig";
import { saveProfile, type Profile } from "../src/profiles";
import { setKey, deleteKey } from "../src/keychain";
import { setupTestRepo, type TestRepoHandle } from "./helpers/test-repo";

const TEST_REPO = "vsync_status_bin_test";

const baseCfg: ConfigFile = {
  version: 1,
  s3: {
    endpoint: "https://hel1.example.com",
    region: "auto",
    bucket: "personal-secrets",
    accessKeyId: "ak",
    secretAccessKey: "sk",
    useSsl: true,
  },
  encryption: { salt: "a-long-enough-salt-string" },
};

const sampleProfile: Profile = {
  version: 1,
  endpoint: "https://hel1.example.com",
  region: "auto",
  bucket: "personal-secrets",
  prefix: "video-ai/",
  accessKeyId: "AKIAEXAMPLE000000000",
  secretAccessKey: "very-secret-key",
};

let tmpRoot: string;
let prevXdg: string | undefined;
let repoHandle: TestRepoHandle;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "vsync-bin-status-"));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpRoot;
  // v0.16: ephemeral git repo + .vsync pin so resolver returns TEST_REPO.
  repoHandle = setupTestRepo(TEST_REPO);
});

afterAll(async () => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  for (const env of ["dev", "prod", "staging", "qa"]) {
    await deleteKey(TEST_REPO, env);
  }
  repoHandle.restore();
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  rmSync(join(tmpRoot, "vsync"), { recursive: true, force: true });
  for (const env of ["dev", "prod", "staging", "qa"]) {
    await deleteKey(TEST_REPO, env);
  }
});

const emptyReport: StatusReport = {
  repo: TEST_REPO,
  envs: [],
  profiles: [],
  notices: [],
  keychainEnumerationSupported: true,
  source: "file",
  sourceDetail: "/tmp/test/.vsync",
  toplevel: "/tmp/test",
  cwd: "/tmp/test",
  originUrl: null,
  worktree: null,
};

describe("renderStatusText", () => {
  test("empty state mentions repo and a hint to add a profile", () => {
    const out = renderStatusText(emptyReport);
    expect(out).toContain(TEST_REPO);
    expect(out).toMatch(/no envs|0 envs|env\s+profile/);
  });

  test("table contains env, profile, prefix columns", () => {
    const rep: StatusReport = {
      ...emptyReport,
      envs: [
        {
          env: "dev",
          profile: "hetzner-personal",
          profilePresent: true,
          prefix: "video-ai/dev/",
          orphan: null,
          status: { ok: true, code: "ok", message: "ok" },
        },
      ],
    };
    const out = renderStatusText(rep);
    expect(out).toContain("dev");
    expect(out).toContain("hetzner-personal");
    expect(out).toContain("video-ai/dev/");
    expect(out).toContain("ok");
  });

  test("dangling profile gets a REMOVED annotation", () => {
    const rep: StatusReport = {
      ...emptyReport,
      envs: [
        {
          env: "dev",
          profile: "deleted",
          profilePresent: false,
          prefix: "video-ai/dev/",
          orphan: null,
          status: {
            ok: false,
            code: "dangling-profile",
            message: "profile deleted not found",
          },
        },
      ],
    };
    const out = renderStatusText(rep);
    expect(out).toMatch(/deleted.*REMOVED/);
  });

  test("orphan-no-key surfaces a clear message", () => {
    const rep: StatusReport = {
      ...emptyReport,
      envs: [
        {
          env: "dev",
          orphan: "no-key",
          status: {
            ok: false,
            code: "orphan-no-key",
            message: "config exists but no key",
          },
        },
      ],
    };
    const out = renderStatusText(rep);
    expect(out).toContain("dev");
    expect(out.toLowerCase()).toMatch(/orphan|no key|no-key/);
  });

  test("renders profile panel after envs", () => {
    const rep: StatusReport = {
      ...emptyReport,
      profiles: [
        { name: "hetzner-personal", endpoint: "https://hel1.example.com", bucket: "personal-secrets" },
      ],
    };
    const out = renderStatusText(rep);
    expect(out).toContain("hetzner-personal");
    expect(out).toContain("hel1.example.com");
  });

  test("includes notices block when present", () => {
    const rep: StatusReport = {
      ...emptyReport,
      notices: ["keychain enumeration not supported"],
    };
    const out = renderStatusText(rep);
    expect(out).toContain("keychain enumeration");
  });
});

describe("renderStatusJson", () => {
  test("emits a well-formed JSON string matching the spec shape", () => {
    const rep: StatusReport = {
      ...emptyReport,
      envs: [
        {
          env: "dev",
          profile: "hetzner-personal",
          profilePresent: true,
          prefix: "video-ai/dev/",
          orphan: null,
          status: { ok: true, code: "ok", message: "ok" },
        },
      ],
      profiles: [{ name: "hetzner-personal", endpoint: "x", bucket: "b" }],
      notices: ["note-one"],
    };
    const j = JSON.parse(renderStatusJson(rep));
    expect(j.repo).toBe(TEST_REPO);
    expect(j.envs[0].env).toBe("dev");
    expect(j.envs[0].profile).toBe("hetzner-personal");
    expect(j.envs[0].status.code).toBe("ok");
    expect(j.profiles[0].name).toBe("hetzner-personal");
    expect(j.notices).toEqual(["note-one"]);
  });
});

describe("main — flag handling", () => {
  let originalExit: any;
  let originalLog: any;
  let originalErr: any;
  let logBuf: string[];
  let errBuf: string[];
  let exitCalls: number[];

  beforeEach(() => {
    originalExit = process.exit;
    originalLog = console.log;
    originalErr = console.error;
    logBuf = [];
    errBuf = [];
    exitCalls = [];
    process.exit = ((code?: number) => {
      exitCalls.push(code ?? 0);
      throw new Error(`__exit:${code ?? 0}`);
    }) as any;
    console.log = (msg?: unknown) => {
      logBuf.push(String(msg ?? ""));
    };
    console.error = (msg?: unknown) => {
      errBuf.push(String(msg ?? ""));
    };
  });

  function restore() {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalErr;
  }

  test("--json + --quiet together → usage error, exit 1", async () => {
    let threw = false;
    try {
      await main(["--json", "--quiet"]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:1");
    } finally {
      restore();
    }
    expect(threw).toBe(true);
    expect(errBuf.join("\n").toLowerCase()).toMatch(/mutually exclusive|both/);
  });

  test("--json prints JSON to stdout", async () => {
    await saveProfile("hetzner-personal", sampleProfile);
    const cfg: ConfigFile = {
      ...baseCfg,
      initProfile: "hetzner-personal",
      prefix: "video-ai/dev/",
    };
    await saveConfigFile(TEST_REPO, "dev", cfg);
    await setKey(TEST_REPO, "dev", "x".repeat(44));

    try {
      await main(["--json"]);
    } finally {
      restore();
    }
    const out = logBuf.join("\n");
    expect(() => JSON.parse(out)).not.toThrow();
    const j = JSON.parse(out);
    expect(j.repo).toBe(TEST_REPO);
    expect(j.envs.find((e: any) => e.env === "dev").status.code).toBe("ok");
  });

  test("--quiet with all-ok exits 0 silently", async () => {
    await saveProfile("hetzner-personal", sampleProfile);
    const cfg: ConfigFile = {
      ...baseCfg,
      initProfile: "hetzner-personal",
      prefix: "video-ai/dev/",
    };
    await saveConfigFile(TEST_REPO, "dev", cfg);
    await setKey(TEST_REPO, "dev", "x".repeat(44));

    let threw = false;
    try {
      await main(["--quiet"]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:0");
    } finally {
      restore();
    }
    // exit 0 may or may not call process.exit explicitly; both are OK
    if (threw) {
      expect(exitCalls).toContain(0);
    }
    // logBuf should be empty or near-empty
    expect(logBuf.join("\n").trim()).toBe("");
  });

  test("--quiet with orphan exits 1", async () => {
    const cfg: ConfigFile = {
      ...baseCfg,
      initProfile: "hetzner-personal",
      prefix: "video-ai/dev/",
    };
    await saveConfigFile(TEST_REPO, "dev", cfg);
    // no setKey → orphan-no-key

    let threw = false;
    try {
      await main(["--quiet"]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:1");
    } finally {
      restore();
    }
    expect(threw).toBe(true);
    expect(exitCalls).toContain(1);
  });

  test("default (no flags) prints tabular output", async () => {
    await saveProfile("hetzner-personal", sampleProfile);
    const cfg: ConfigFile = {
      ...baseCfg,
      initProfile: "hetzner-personal",
      prefix: "video-ai/dev/",
    };
    await saveConfigFile(TEST_REPO, "dev", cfg);
    await setKey(TEST_REPO, "dev", "x".repeat(44));

    try {
      await main([]);
    } finally {
      restore();
    }
    const out = logBuf.join("\n");
    expect(out).toContain("dev");
    expect(out).toContain("hetzner-personal");
    expect(out).toContain("ok");
  });
});
