import { AuthEnv, requireAdmin } from "./auth";
import { json, readJson } from "./http";
import { ApifyEnv, ApifyProvider, ProviderNotConfigured, ingestReference } from "./discovery";
import { SupabaseError, insert, patch, remove, select } from "./supabase";
import { parseHandle, parseId } from "./validation";

export interface ReferencesEnv extends ApifyEnv, AuthEnv {}

type FetchFn = typeof fetch;

async function gate(request: Request, env: AuthEnv, fetchFn: FetchFn): Promise<Response | null> {
  const auth = await requireAdmin(request, env, fetchFn);
  if (auth.ok) return null;
  return json({ error: auth.status === 401 ? "unauthorised" : "forbidden" }, auth.status);
}

const REF_COLUMNS =
  "select=id,username,enabled,discovery_interval_minutes,last_scraped_at,last_error,last_post_count&order=username";

export async function listReferences(request: Request, env: ReferencesEnv, fetchFn: FetchFn = fetch) {
  const denied = await gate(request, env, fetchFn);
  if (denied) return denied;
  return json({ references: await select(env, "reference_accounts", REF_COLUMNS, fetchFn) });
}

export async function createReference(request: Request, env: ReferencesEnv, fetchFn: FetchFn = fetch) {
  const denied = await gate(request, env, fetchFn);
  if (denied) return denied;
  const body = (await readJson(request)) as { username?: unknown } | null;
  const username = parseHandle(body?.username);
  if (!username) return json({ error: "invalid_username" }, 400);
  try {
    const [row] = await insert(env, "reference_accounts", { username }, fetchFn);
    return json({ reference: row }, 201);
  } catch (err) {
    if (err instanceof SupabaseError && err.status === 409) return json({ error: "already_exists" }, 409);
    throw err;
  }
}

export async function updateReference(request: Request, env: ReferencesEnv, idRaw: string, fetchFn: FetchFn = fetch) {
  const denied = await gate(request, env, fetchFn);
  if (denied) return denied;
  const id = parseId(idRaw);
  if (!id) return json({ error: "invalid_id" }, 400);
  const body = (await readJson(request)) as { enabled?: unknown; discovery_interval_minutes?: unknown } | null;
  const changes: Record<string, unknown> = {};
  if (typeof body?.enabled === "boolean") changes.enabled = body.enabled;
  if (body?.discovery_interval_minutes !== undefined) {
    const n = Number(body.discovery_interval_minutes);
    if (!Number.isInteger(n) || n < 15 || n > 10080) return json({ error: "invalid_interval" }, 400);
    changes.discovery_interval_minutes = n;
  }
  if (Object.keys(changes).length === 0) return json({ error: "nothing_to_update" }, 400);
  const rows = await patch(env, "reference_accounts", `id=eq.${id}`, changes, fetchFn);
  return json({ reference: rows[0] ?? null });
}

export async function deleteReference(request: Request, env: ReferencesEnv, idRaw: string, fetchFn: FetchFn = fetch) {
  const denied = await gate(request, env, fetchFn);
  if (denied) return denied;
  const id = parseId(idRaw);
  if (!id) return json({ error: "invalid_id" }, 400);
  await remove(env, "reference_accounts", `id=eq.${id}`, fetchFn);
  return json({ ok: true });
}

// Manually runs discovery for one reference source.
export async function runReferenceDiscovery(request: Request, env: ReferencesEnv, idRaw: string, fetchFn: FetchFn = fetch) {
  const denied = await gate(request, env, fetchFn);
  if (denied) return denied;
  const id = parseId(idRaw);
  if (!id) return json({ error: "invalid_id" }, 400);
  try {
    const result = await ingestReference(env, id, new ApifyProvider(env, fetchFn), fetchFn);
    return json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof ProviderNotConfigured) return json({ error: "apify_not_configured" }, 503);
    return json({ error: "discovery_failed" }, 502);
  }
}
