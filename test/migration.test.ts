import {
  test,
  expect,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  statSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateLegacyDefaultsIfNeeded } from "../src/migration";
import { vsyncBaseDir } from "../src/defaults";
import { getProfilesDir } from "../src/profiles";

let tmpRoot: string;
let prevXdg: string | undefined;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "vsync-migration-"));
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

function makeLegacyDefaults(): string {
  const dir = vsyncBaseDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "defaults");
  writeFileSync(file, "gzipped-blob-placeholder", { mode: 0o600 });
  return file;
}

describe("migrateLegacyDefaultsIfNeeded", () => {
  test("no-op when defaults does not exist", () => {
    const stderrBuf: string[] = [];
    const ran = migrateLegacyDefaultsIfNeeded({
      writeStderr: (s) => stderrBuf.push(s),
    });
    expect(ran).toBe(false);
    expect(stderrBuf.join("")).toBe("");
  });

  test("renames defaults → defaults.bak when profiles dir absent", () => {
    const file = makeLegacyDefaults();
    const bak = file + ".bak";

    const stderrBuf: string[] = [];
    const ran = migrateLegacyDefaultsIfNeeded({
      writeStderr: (s) => stderrBuf.push(s),
    });

    expect(ran).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(bak)).toBe(true);
    // profiles dir was created
    expect(existsSync(getProfilesDir())).toBe(true);

    // notice goes to stderr (not stdout)
    const msg = stderrBuf.join("");
    expect(msg).toContain("defaults.bak");
    expect(msg).toContain("vsync profile add");
  });

  test("no-op when profiles dir already exists (even if defaults present)", () => {
    const file = makeLegacyDefaults();
    mkdirSync(getProfilesDir(), { recursive: true, mode: 0o700 });

    const stderrBuf: string[] = [];
    const ran = migrateLegacyDefaultsIfNeeded({
      writeStderr: (s) => stderrBuf.push(s),
    });

    expect(ran).toBe(false);
    expect(existsSync(file)).toBe(true); // untouched
    expect(stderrBuf.join("")).toBe("");
  });

  test("preserves 0600 mode on the .bak file", () => {
    if (process.platform === "win32") return;
    const file = makeLegacyDefaults();
    migrateLegacyDefaultsIfNeeded({ writeStderr: () => {} });
    const mode = statSync(file + ".bak").mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("preserves the file content", () => {
    const file = makeLegacyDefaults();
    const orig = readFileSync(file);
    migrateLegacyDefaultsIfNeeded({ writeStderr: () => {} });
    const moved = readFileSync(file + ".bak");
    expect(moved.equals(orig)).toBe(true);
  });

  test("idempotent — second run does nothing", () => {
    makeLegacyDefaults();

    const buf1: string[] = [];
    const r1 = migrateLegacyDefaultsIfNeeded({
      writeStderr: (s) => buf1.push(s),
    });
    expect(r1).toBe(true);

    const buf2: string[] = [];
    const r2 = migrateLegacyDefaultsIfNeeded({
      writeStderr: (s) => buf2.push(s),
    });
    expect(r2).toBe(false);
    expect(buf2.join("")).toBe("");
  });
});
