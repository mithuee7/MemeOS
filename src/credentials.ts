// AES-GCM encryption for third-party keys stored in the database.
// CREDENTIALS_KEY is a 32-byte key, base64 encoded, held only as a Worker secret.

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function importKey(keyB64: string): Promise<CryptoKey> {
  const raw = unb64(keyB64);
  if (raw.length !== 32) throw new Error("credentials_key_invalid");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(plaintext: string, keyB64: string): Promise<{ ciphertext: string; iv: string }> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const buf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  return { ciphertext: b64(new Uint8Array(buf)), iv: b64(iv) };
}

export async function decryptSecret(ciphertext: string, iv: string, keyB64: string): Promise<string> {
  const key = await importKey(keyB64);
  const buf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, key, unb64(ciphertext));
  return dec.decode(buf);
}

// Only the last four characters are ever shown back to a user.
export function maskTail(value: string): string {
  return value.length > 4 ? value.slice(-4) : "****";
}
