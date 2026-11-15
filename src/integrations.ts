import { AuthEnv, requireAdmin } from "./auth";
import { decryptSecret, encryptSecret, maskTail } from "./credentials";
import { json, readJson } from "./http";
import { SupabaseEnv, patch, remove, select } from "./supabase";

export const PROVIDERS = ["apify", "groq", "meta"] as const;
export type Provider = (typeof PROVIDERS)[number];

// Environment variables that take precedence over saved keys, if set as Worker secrets.
const ENV_FALLBACK: Record<Provider, string> = {
  apify: "APIFY_TOKEN",
  groq: "GROQ_API_KEY",
  meta: "META_ACCESS_TOKEN",
};

export interface IntegrationsEnv extends AuthEnv {
  CREDENTIALS_KEY?: string;
  APIFY_TOKEN?: string;
  GROQ_API_KEY?: string;
  META_ACCESS_TOKEN?: string;
}

type FetchFn = typeof fetch;

export function isProvider(v: string): v is Provider {
  return (PROVIDERS as readonly string[]).includes(v);
}

// Returns the usable secret for a provider: the Worker secret if present, else the saved key.
export async function resolveSecret(env: IntegrationsEnv, provider: Provider): Promise<string | null> {
  const fromEnv = env[ENV_FALLBACK[provider] as keyof IntegrationsEnv];
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  if (!env.CREDENTIALS_KEY) return null;
  const [row] = await select<{ ciphertext: string; iv: string }>(
    env,
    "integration_credentials",
    `select=ciphertext,iv&provider=eq.${provider}`,
  );
  if (!row) return null;
  return decryptSecret(row.ciphertext, row.iv, env.CREDENTIALS_KEY);
}

async function gate(request: Request, env: AuthEnv, fetchFn: FetchFn): Promise<Response | null> {
  const auth = await requireAdmin(request, env, fetchFn);
  if (auth.ok) return null;
  return json({ error: auth.status === 401 ? "unauthorised" : "forbidden" }, auth.status);
}

// Provider check endpoints. Each returns only a fixed status message, never the raw response.
const TESTS: Record<Provider, { url: string; header: (k: string) => Record<string, string> }> = {
  apify: { url: "https://api.apify.com/v2/users/me", header: (k) => ({ authorization: `Bearer ${k}` }) },
  groq: { url: "https://api.groq.com/openai/v1/models", header: (k) => ({ authorization: `Bearer ${k}` }) },
  meta: { url: "https://graph.facebook.com/v21.0/me?fields=id", header: (k) => ({ authorization: `Bearer ${k}` }) },
};

export async function testProvider(env: IntegrationsEnv, provider: Provider, fetchFn: FetchFn): Promise<{ status: "ok" | "failed"; detail: string }> {
  const key = await resolveSecret(env, provider);
  if (!key) return { status: "failed", detail: "No key saved." };
  const t = TESTS[provider];
  try {
    const res = await fetchFn(t.url, { headers: t.header(key) });
    if (res.ok) return { status: "ok", detail: "Connected." };
    if (res.status === 401 || res.status === 403) return { status: "failed", detail: "Key was rejected." };
    if (res.status === 429) return { status: "failed", detail: "Rate limited. Try again later." };
    return { status: "failed", detail: `Provider returned status ${res.status}.` };
  } catch {
    return { status: "failed", detail: "Could not reach the provider." };
  }
}

const SELECT = "select=provider,last4,status,status_detail,updated_at,tested_at";

export async function listIntegrations(request: Request, env: IntegrationsEnv, fetchFn: FetchFn = fetch) {
  const denied = await gate(request, env, fetchFn);
  if (denied) return denied;
  const rows = await select<{ provider: Provider; last4: string; status: string; status_detail: string | null; updated_at: string; tested_at: string | null }>(
    env,
    "integration_credentials",
    SELECT,
    fetchFn,
  );
  const items = PROVIDERS.map((p) => {
    const row = rows.find((r) => r.provider === p);
    const fromEnv = Boolean(env[ENV_FALLBACK[p] as keyof IntegrationsEnv]);
    return {
      provider: p,
      configured: Boolean(row) || fromEnv,
      source: fromEnv ? "worker_secret" : row ? "saved" : null,
      last4: row?.last4 ?? null,
      status: row?.status ?? (fromEnv ? "untested" : "not_configured"),
      status_detail: row?.status_detail ?? null,
      updated_at: row?.updated_at ?? null,
      tested_at: row?.tested_at ?? null,
    };
  });
  return json({ integrations: items, encryption_ready: Boolean(env.CREDENTIALS_KEY) });
}

export async function saveIntegration(request: Request, env: IntegrationsEnv, providerRaw: string, fetchFn: FetchFn = fetch) {
  const denied = await gate(request, env, fetchFn);
  if (denied) return denied;
  if (!isProvider(providerRaw)) return json({ error: "unknown_provider" }, 404);
  if (!env.CREDENTIALS_KEY) return json({ error: "encryption_not_configured" }, 503);

  const body = (await readJson(request)) as { value?: unknown } | null;
  const value = typeof body?.value === "string" ? body.value.trim() : "";
  if (value.length < 8 || value.length > 300 || /\s/.test(value)) return json({ error: "invalid_key" }, 400);

  const { ciphertext, iv } = await encryptSecret(value, env.CREDENTIALS_KEY);
  const row = {
    provider: providerRaw,
    ciphertext,
    iv,
    last4: maskTail(value),
    status: "untested",
    status_detail: null,
    updated_at: new Date().toISOString(),
    tested_at: null,
  };
  await upsert(env, row, fetchFn);
  return json({ ok: true, last4: row.last4 });
}

async function upsert(env: SupabaseEnv, row: Record<string, unknown>, fetchFn: FetchFn) {
  const res = await fetchFn(`${env.SUPABASE_URL}/rest/v1/integration_credentials?on_conflict=provider`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw new Error("save_failed");
}

export async function deleteIntegration(request: Request, env: IntegrationsEnv, providerRaw: string, fetchFn: FetchFn = fetch) {
  const denied = await gate(request, env, fetchFn);
  if (denied) return denied;
  if (!isProvider(providerRaw)) return json({ error: "unknown_provider" }, 404);
  await remove(env, "integration_credentials", `provider=eq.${providerRaw}`, fetchFn);
  return json({ ok: true });
}

export async function checkIntegration(request: Request, env: IntegrationsEnv, providerRaw: string, fetchFn: FetchFn = fetch) {
  const denied = await gate(request, env, fetchFn);
  if (denied) return denied;
  if (!isProvider(providerRaw)) return json({ error: "unknown_provider" }, 404);
  const result = await testProvider(env, providerRaw, fetchFn);
  await patch(env, "integration_credentials", `provider=eq.${providerRaw}`, {
    status: result.status,
    status_detail: result.detail,
    tested_at: new Date().toISOString(),
  }, fetchFn).catch(() => undefined);
  return json({ provider: providerRaw, ...result });
}

