import { describe, expect, it, vi, afterEach } from "vitest";
import { decryptSecret, encryptSecret, maskTail } from "../src/credentials";
import { testProvider, resolveSecret } from "../src/integrations";
import worker from "../src/index";

// A valid 32-byte key, base64 encoded (test only).
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i + 1)));

const BASE = {
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service-secret",
  APIFY_ACTOR_ID: "actor~test",
  CREDENTIALS_KEY: KEY,
};

afterEach(() => vi.unstubAllGlobals());

describe("encryption", () => {
  it("round-trips a key and never stores it in plaintext", async () => {
    const { ciphertext, iv } = await encryptSecret("apify_api_SUPERSECRET1234", KEY);
    expect(ciphertext).not.toContain("SUPERSECRET");
    expect(await decryptSecret(ciphertext, iv, KEY)).toBe("apify_api_SUPERSECRET1234");
  });

  it("uses a fresh IV each time, so the same key encrypts differently", async () => {
    const a = await encryptSecret("same-value-123", KEY);
    const b = await encryptSecret("same-value-123", KEY);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.iv).not.toBe(b.iv);
  });

  it("fails to decrypt with the wrong key", async () => {
    const { ciphertext, iv } = await encryptSecret("value-abcdefgh", KEY);
    const other = btoa(String.fromCharCode(...new Uint8Array(32).fill(9)));
    await expect(decryptSecret(ciphertext, iv, other)).rejects.toThrow();
  });

  it("rejects a key that is not 32 bytes", async () => {
    await expect(encryptSecret("value-abcdefgh", btoa("short"))).rejects.toThrow("credentials_key_invalid");
  });

  it("masks all but the last four characters", () => {
    expect(maskTail("abcdefgh1234")).toBe("1234");
    expect(maskTail("abc")).toBe("****");
  });
});

describe("provider checks", () => {
  it("reports ok only on a successful response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    const env = { ...BASE, APIFY_TOKEN: "apify-token-123456" };
    expect(await testProvider(env as never, "apify", fetch)).toEqual({ status: "ok", detail: "Connected." });
  });

  it("reports rejected keys without echoing the provider body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("secret body leak", { status: 401 })));
    const env = { ...BASE, GROQ_API_KEY: "gsk_test_key_123456" };
    const result = await testProvider(env as never, "groq", fetch);
    expect(result).toEqual({ status: "failed", detail: "Key was rejected." });
    expect(JSON.stringify(result)).not.toContain("secret body leak");
  });

  it("says no key is saved when none exists", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    expect(await testProvider(BASE as never, "meta", fetch)).toEqual({ status: "failed", detail: "No key saved." });
  });

  it("prefers a Worker secret over a saved key", async () => {
    const fetchFn = vi.fn(async () => new Response("[]", { status: 200 }));
    const env = { ...BASE, GROQ_API_KEY: "from-worker-secret" };
    expect(await resolveSecret(env as never, "groq")).toBe("from-worker-secret");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("integration routes", () => {
  it("rejects anonymous saves", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const res = await worker.fetch(
      new Request("https://w.test/api/integrations/groq", { method: "PUT", body: JSON.stringify({ value: "gsk_abcdefgh" }) }),
      BASE as never,
    );
    expect(res.status).toBe(401);
  });

  it("requires login before revealing which providers exist", async () => {
    const res = await worker.fetch(new Request("https://w.test/api/integrations/evil", { method: "PUT" }), BASE as never);
    expect(res.status).toBe(401);
  });

  it("never returns a stored key from the list endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "admin-1" }), { status: 200 });
      if (url.includes("admin_users")) return new Response(JSON.stringify([{ user_id: "admin-1" }]), { status: 200 });
      return new Response(JSON.stringify([{ provider: "groq", last4: "3456", status: "ok" }]), { status: 200 });
    }));
    const res = await worker.fetch(
      new Request("https://w.test/api/integrations", { headers: { authorization: "Bearer t" } }),
      BASE as never,
    );
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("3456");
    expect(body).not.toMatch(/ciphertext|\biv\b|gsk_/);
  });
});
