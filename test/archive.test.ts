import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipFolder, unzipTo } from "../src/archive";

describe("archive", () => {
  let src: string;
  let dest: string;
  let zip: string | null = null;

  beforeEach(() => {
    src = mkdtempSync(join(tmpdir(), "archive-src-"));
    dest = mkdtempSync(join(tmpdir(), "archive-dest-"));
  });

  afterEach(() => {
    if (zip && existsSync(zip)) unlinkSync(zip);
    rmSync(src, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
    zip = null;
  });

  test("zipFolder + unzipTo roundtrips contents and structure", async () => {
    await Bun.write(join(src, "a.txt"), "hello");
    mkdirSync(join(src, "sub"), { recursive: true });
    await Bun.write(join(src, "sub", "b.txt"), "world");

    zip = await zipFolder(src);
    expect(existsSync(zip)).toBe(true);

    await unzipTo(zip, dest);
    expect(await Bun.file(join(dest, "a.txt")).text()).toBe("hello");
    expect(await Bun.file(join(dest, "sub", "b.txt")).text()).toBe("world");
  });

  test("unzipTo creates target folder if missing", async () => {
    await Bun.write(join(src, "x.txt"), "x");
    zip = await zipFolder(src);
    const newDest = join(dest, "deep", "nested");
    await unzipTo(zip, newDest);
    expect(await Bun.file(join(newDest, "x.txt")).text()).toBe("x");
  });

  test("zipFolder errors on missing folder", async () => {
    expect(zipFolder(join(tmpdir(), "definitely-does-not-exist-xyz"))).rejects.toThrow();
  });
});
