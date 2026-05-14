// passphrase.ts — generate short, readable passphrases for the share file
// wrapper. Goals: easy to type, easy to copy, no visually-confusable
// characters (no 0/O/1/l/I), three hyphen-separated groups so eyes can
// pair them with confidence on a Slack DM.
//
// Default shape: XXXX-XXXX-XXXX (12 chars + 2 hyphens = 14 total).

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ";

export const PASSPHRASE_MIN_LEN = 8;

export function generatePassphrase(groups = 3, perGroup = 4): string {
  if (groups < 1 || perGroup < 2) {
    throw new Error("generatePassphrase: at least 1 group of 2 chars");
  }
  const total = groups * perGroup;
  const bytes = new Uint8Array(total);
  crypto.getRandomValues(bytes);
  const chars: string[] = [];
  for (let i = 0; i < total; i++) {
    chars.push(ALPHABET[bytes[i]! % ALPHABET.length]);
  }
  const out: string[] = [];
  for (let g = 0; g < groups; g++) {
    out.push(chars.slice(g * perGroup, (g + 1) * perGroup).join(""));
  }
  return out.join("-");
}

/** Strip surrounding whitespace + reject obvious typos before decrypting. */
export function normalizePassphrase(input: string): string {
  const trimmed = (input ?? "").trim();
  if (trimmed.length < PASSPHRASE_MIN_LEN) {
    throw new Error(
      `passphrase must be at least ${PASSPHRASE_MIN_LEN} characters (got ${trimmed.length})`,
    );
  }
  return trimmed;
}
