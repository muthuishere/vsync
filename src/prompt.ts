// prompt.ts — tiny TTY input helpers used by every CLI subcommand so the
// same verb can be driven entirely by flags ("--bucket=foo --region=…")
// for scripting, OR by interactive prompts when flags are missing.
//
// Three helpers:
//   askText / askBool / askSecret   — promise-returning readline calls
//   resolveOrAsk(value, question)   — uses the provided value or prompts
//   confirmYes(question)            — small y/n with a default
//
// We deliberately avoid third-party deps. Bun ships with a global
// `prompt()` (Web standard) for plain text. For hidden input we toggle
// raw mode on process.stdin and read char-by-char so passphrases don't
// echo to the screen.

import { stdin, stdout } from "node:process";

/** True when stdin is a real TTY (so prompts make sense). */
export function isTty(): boolean {
  return Boolean((stdin as any).isTTY);
}

/** Bun's global prompt(), with a default-value fallback when offered. */
export function askText(label: string, defaultValue?: string): string {
  const promptStr =
    defaultValue !== undefined ? `${label} [${defaultValue}]: ` : `${label}: `;
  const v = (globalThis as any).prompt(promptStr);
  if (v === null || v === undefined) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error("aborted (no input)");
  }
  const trimmed = String(v).trim();
  return trimmed || defaultValue || "";
}

/** y/n prompt; honours a default if user just hits enter. */
export function askBool(label: string, defaultValue: boolean): boolean {
  const def = defaultValue ? "Y/n" : "y/N";
  const v = (globalThis as any).prompt(`${label} [${def}]: `);
  if (v === null || v === undefined) return defaultValue;
  const t = String(v).trim().toLowerCase();
  if (!t) return defaultValue;
  return t.startsWith("y");
}

/** Hidden input — toggles raw mode on TTY and masks each keystroke. */
export async function askSecret(label: string): Promise<string> {
  if (!isTty()) {
    // Non-TTY (piped stdin) — just read a line.
    return await readLineFromStdin(label);
  }
  stdout.write(label + ": ");
  return await new Promise<string>((resolve, reject) => {
    const buf: string[] = [];
    (stdin as any).setRawMode?.(true);
    (stdin as any).resume?.();
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\n" || ch === "\r" || ch === "") {
          (stdin as any).setRawMode?.(false);
          stdin.off("data", onData);
          stdin.pause();
          stdout.write("\n");
          resolve(buf.join("").trim());
          return;
        }
        if (ch === "") {
          (stdin as any).setRawMode?.(false);
          stdin.off("data", onData);
          stdin.pause();
          stdout.write("\n");
          reject(new Error("aborted"));
          return;
        }
        if (ch === "" || ch === "\b") {
          if (buf.length) {
            buf.pop();
            stdout.write("\b \b");
          }
          continue;
        }
        buf.push(ch);
        stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

async function readLineFromStdin(label: string): Promise<string> {
  if (label) stdout.write(label + ": ");
  return await new Promise<string>((resolve) => {
    let buf = "";
    stdin.setEncoding("utf8");
    const onData = (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        stdin.off("data", onData);
        resolve(buf.slice(0, nl).trim());
      }
    };
    stdin.once("end", () => resolve(buf.trim()));
    stdin.on("data", onData);
  });
}

/** Use the provided value if defined+non-empty, otherwise prompt. Throws
 *  if not a TTY and no value was given (can't prompt non-interactively). */
export function resolveOrAsk(
  value: string | undefined,
  label: string,
  defaultValue?: string,
): string {
  if (value !== undefined && value !== "") return value;
  if (!isTty()) {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(
      `missing ${label} and stdin is not a TTY — pass --${label.toLowerCase().replace(/\s+/g, "-")}=… on the command line`,
    );
  }
  return askText(label, defaultValue);
}

/** Yes/no confirmation. If --yes flag pre-set, returns true silently. */
export function confirmYes(label: string, preApproved: boolean): boolean {
  if (preApproved) return true;
  if (!isTty()) {
    throw new Error(
      `${label} requires interactive confirmation — pass --yes to bypass`,
    );
  }
  return askBool(label, false);
}
