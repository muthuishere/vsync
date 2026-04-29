// Resolve the repo root via `git rev-parse --show-toplevel`, falling back to
// process.cwd() if not in a git repo (or git isn't on PATH).

export async function getRepoRoot(): Promise<string> {
  const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const code = await proc.exited;
  if (code === 0) {
    return (await new Response(proc.stdout).text()).trim();
  }
  return process.cwd();
}
