// Input validation for all write endpoints. Anything external (including
// scraped captions or usernames) is treated as untrusted.

// Instagram usernames: 1-30 chars, letters, digits, periods and underscores.
const HANDLE_RE = /^[a-z0-9._]{1,30}$/;

export function parseHandle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const handle = value.trim().replace(/^@/, "").toLowerCase();
  if (!HANDLE_RE.test(handle)) return null;
  if (handle.startsWith(".") || handle.endsWith(".")) return null;
  if (handle.includes("..")) return null;
  return handle;
}

export function parseId(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^[1-9]\d{0,15}$/.test(value)) return Number(value);
  return null;
}
