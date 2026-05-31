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
  maskAccessKey,
  renderProfileList,
  renderProfileShow,
  main,
} from "../bin/profile";
import { saveProfile, type Profile } from "../src/profiles";

const sample: Profile = {
  version: 1,
  endpoint: "https://hel1.your-objectstorage.com",
  region: "auto",
  bucket: "personal-secrets",
  prefix: "video-ai/",
  accessKeyId: "AKIAIOSFODNN7EXGXQ4",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

let tmpRoot: string;
let prevXdg: string | undefined;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "vsync-bin-profile-"));
  prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpRoot;
});

afterAll(() => {
  if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = prevXdg;
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(join(tmpRoot, "vsync"), { recursive: true, force: true });
});

describe("maskAccessKey", () => {
  test("keeps last 4 chars visible, masks the rest", () => {
    expect(maskAccessKey("AKIAIOSFODNN7EXGXQ4")).toBe("AKIA***********GXQ4");
  });

  test("short keys (<=4 chars) become all stars", () => {
    expect(maskAccessKey("abcd")).toBe("****");
    expect(maskAccessKey("ab")).toBe("**");
  });

  test("empty stays empty", () => {
    expect(maskAccessKey("")).toBe("");
  });

  test("preserves the prefix shape AKIA + stars + last4", () => {
    const m = maskAccessKey("AKIAABCDEFGHIJKLMNOP");
    expect(m.startsWith("AKIA")).toBe(true);
    expect(m.endsWith("MNOP")).toBe(true);
    expect(m).toMatch(/^AKIA\*+MNOP$/);
  });
});

describe("renderProfileList", () => {
  test("empty state message names the profiles dir", () => {
    const out = renderProfileList([], "/tmp/p");
    expect(out).toContain("no profiles");
    expect(out).toContain("vsync profile add");
  });

  test("table contains name, endpoint, bucket columns", () => {
    const out = renderProfileList(
      [
        { name: "hetzner-personal", ...sample },
        {
          name: "aws-prod",
          ...sample,
          endpoint: "https://s3.eu-central-1.amazonaws.com",
          bucket: "prod-bucket",
        },
      ],
      "/tmp/p",
    );
    expect(out).toMatch(/name\s+endpoint\s+bucket/);
    expect(out).toContain("hetzner-personal");
    expect(out).toContain("aws-prod");
    expect(out).toContain("hel1.your-objectstorage.com");
    expect(out).toContain("personal-secrets");
    expect(out).toContain("2 profiles at /tmp/p");
  });

  test("never prints secretAccessKey or accessKeyId", () => {
    const out = renderProfileList([{ name: "p", ...sample }], "/tmp/p");
    expect(out).not.toContain(sample.secretAccessKey);
    expect(out).not.toContain(sample.accessKeyId);
  });
});

describe("renderProfileShow", () => {
  test("masks secret entirely and access-key tail-4", () => {
    const out = renderProfileShow("hetzner", sample, "/tmp/p/hetzner.json");
    expect(out).toContain("hetzner");
    expect(out).toContain("https://hel1.your-objectstorage.com");
    expect(out).toContain("personal-secrets");
    // secret fully redacted
    expect(out).not.toContain(sample.secretAccessKey);
    expect(out).toContain("secretAccessKey:");
    expect(out).toMatch(/secretAccessKey:\s+\*+/);
    // access-key masked, last 4 visible
    expect(out).not.toContain(sample.accessKeyId);
    expect(out).toContain("GXQ4");
  });

  test("--reveal-secret prints plaintext secret with a warning", () => {
    const out = renderProfileShow(
      "hetzner",
      sample,
      "/tmp/p/hetzner.json",
      { revealSecret: true },
    );
    expect(out).toContain(sample.secretAccessKey);
  });

  test("shows missing prefix as '(none)'", () => {
    const { prefix: _p, ...sansPrefix } = sample;
    const out = renderProfileShow(
      "hetzner",
      sansPrefix as Profile,
      "/tmp/p/hetzner.json",
    );
    expect(out).toMatch(/prefix:\s+\(none\)/);
  });
});

describe("main — non-TTY behaviour", () => {
  let originalTty: any;
  let originalExit: any;
  let originalErr: any;
  let originalLog: any;
  let logBuf: string[];
  let errBuf: string[];
  let exitCalls: number[];

  beforeEach(() => {
    originalTty = (process.stdin as any).isTTY;
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
    (process.stdin as any).isTTY = originalTty;
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalErr;
  }

  test("list with no profiles prints empty-state to stdout", async () => {
    (process.stdin as any).isTTY = false;
    try {
      await main(["list"]);
    } finally {
      restore();
    }
    expect(logBuf.join("\n")).toContain("no profiles");
  });

  test("list with one profile prints a table", async () => {
    await saveProfile("hetzner", sample);
    (process.stdin as any).isTTY = false;
    try {
      await main(["list"]);
    } finally {
      restore();
    }
    const out = logBuf.join("\n");
    expect(out).toContain("hetzner");
    expect(out).toContain("personal-secrets");
  });

  test("show <name> redacts secret + masks access-key", async () => {
    await saveProfile("hetzner", sample);
    (process.stdin as any).isTTY = false;
    try {
      await main(["show", "hetzner"]);
    } finally {
      restore();
    }
    const out = logBuf.join("\n");
    expect(out).not.toContain(sample.secretAccessKey);
    expect(out).not.toContain(sample.accessKeyId);
    expect(out).toContain("GXQ4");
  });

  test("show --reveal-secret in non-TTY exits 1 with explanatory message", async () => {
    await saveProfile("hetzner", sample);
    (process.stdin as any).isTTY = false;
    let threw = false;
    try {
      await main(["show", "hetzner", "--reveal-secret"]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:1");
    } finally {
      restore();
    }
    expect(threw).toBe(true);
    expect(exitCalls).toContain(1);
    expect(errBuf.join("\n")).toMatch(/--reveal-secret/);
    expect(errBuf.join("\n").toLowerCase()).toContain("interactive");
  });

  test("show <missing> exits 1 with profile-not-found message", async () => {
    (process.stdin as any).isTTY = false;
    let threw = false;
    try {
      await main(["show", "ghost"]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:1");
    } finally {
      restore();
    }
    expect(threw).toBe(true);
    expect(errBuf.join("\n")).toMatch(/ghost/);
    expect(errBuf.join("\n").toLowerCase()).toContain("not found");
  });

  test("add in non-TTY exits 1", async () => {
    (process.stdin as any).isTTY = false;
    let threw = false;
    try {
      await main(["add", "hetzner"]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:1");
    } finally {
      restore();
    }
    expect(threw).toBe(true);
    expect(errBuf.join("\n").toLowerCase()).toContain("tty");
  });

  test("add of existing name in TTY mode rejects via duplicate error", async () => {
    await saveProfile("hetzner", sample);
    (process.stdin as any).isTTY = true;
    let threw = false;
    try {
      await main(["add", "hetzner"]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:1");
    } finally {
      restore();
    }
    expect(threw).toBe(true);
    expect(errBuf.join("\n")).toMatch(/already exists|already/i);
  });

  test("remove in non-TTY without --yes exits 1", async () => {
    await saveProfile("hetzner", sample);
    (process.stdin as any).isTTY = false;
    let threw = false;
    try {
      await main(["remove", "hetzner"]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:1");
    } finally {
      restore();
    }
    expect(threw).toBe(true);
    expect(errBuf.join("\n").toLowerCase()).toMatch(/confirmation|interactive|tty|yes/);
  });

  test("remove --yes in non-TTY removes silently", async () => {
    await saveProfile("hetzner", sample);
    (process.stdin as any).isTTY = false;
    try {
      await main(["remove", "hetzner", "--yes"]);
    } finally {
      restore();
    }
    // file is gone
    const { profileExists } = await import("../src/profiles");
    expect(await profileExists("hetzner")).toBe(false);
  });

  test("remove of missing exits 1", async () => {
    (process.stdin as any).isTTY = false;
    let threw = false;
    try {
      await main(["remove", "ghost", "--yes"]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:1");
    } finally {
      restore();
    }
    expect(threw).toBe(true);
    expect(errBuf.join("\n").toLowerCase()).toContain("not found");
  });

  test("unknown subcommand prints usage and exits 1", async () => {
    (process.stdin as any).isTTY = false;
    let threw = false;
    try {
      await main(["bogus"]);
    } catch (e: any) {
      threw = true;
      expect(String(e.message)).toBe("__exit:1");
    } finally {
      restore();
    }
    expect(threw).toBe(true);
    expect(errBuf.join("\n").toLowerCase()).toContain("usage");
  });

  test("no subcommand defaults to `list` (does not error)", async () => {
    // Bare `vsync profile` / `vsync profiles` is the common "show me my
    // profiles" intent — it lists rather than printing usage + exit 1.
    (process.stdin as any).isTTY = false;
    let threw = false;
    try {
      await main([]);
    } catch (e: any) {
      threw = true;
    } finally {
      restore();
    }
    expect(threw).toBe(false);
    // Same output as an explicit `list` with no profiles configured.
    expect(logBuf.join("\n")).toContain("no profiles");
  });
});
