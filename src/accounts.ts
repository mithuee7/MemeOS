import { AuthEnv, requireAdmin } from "./auth";
import { SupabaseError, insert, remove, rpc, select } from "./supabase";
import { parseHandle, parseId } from "./validation";
import { json, readJson } from "./http";

export interface Env extends AuthEnv {}

type FetchFn = typeof fetch;

export { json, readJson };

const ACCOUNT_COLUMNS =
  "select=id,handle,discovery_enabled,posts_per_day,audio_fallback,created_at&order=handle";

// Returns a Response for auth failures, or null when the caller is an admin.
async function authorise(request: Request, env: Env, fetchFn: FetchFn): Promise<Response | null> {
  const auth = await requireAdmin(request, env, fetchFn);
  if (auth.ok) return null;
  return json({ error: auth.status === 401 ? "unauthorised" : "forbidden" }, auth.status);
}


export async function listAccounts(request: Request, env: Env, fetchFn: FetchFn = fetch): Promise<Response> {
  const denied = await authorise(request, env, fetchFn);
  if (denied) return denied;
  const accounts = await select(env, "instagram_accounts", ACCOUNT_COLUMNS, fetchFn);
  return json({ accounts });
}

export async function createAccount(request: Request, env: Env, fetchFn: FetchFn = fetch): Promise<Response> {
  const denied = await authorise(request, env, fetchFn);
  if (denied) return denied;

  const body = (await readJson(request)) as { handle?: unknown } | null;
  const handle = parseHandle(body?.handle);
  if (!handle) return json({ error: "invalid_handle" }, 400);

  try {
    const rows = await insert(env, "instagram_accounts", { handle }, fetchFn);
    return json({ account: rows[0] }, 201);
  } catch (err) {
    if (err instanceof SupabaseError && err.status === 409) {
      return json({ error: "handle_exists" }, 409);
    }
    throw err;
  }
}

// Adds a parent edge child -> parent after checking for cycles.
export async function addParent(
  request: Request,
  env: Env,
  childId: unknown,
  fetchFn: FetchFn = fetch,
): Promise<Response> {
  const denied = await authorise(request, env, fetchFn);
  if (denied) return denied;

  const child = parseId(childId);
  const body = (await readJson(request)) as { parent_id?: unknown } | null;
  const parent = parseId(body?.parent_id);
  if (!child || !parent) return json({ error: "invalid_id" }, 400);
  if (child === parent) return json({ error: "self_parent" }, 400);

  const cycle = await rpc<boolean>(env, "would_create_cycle", { child_id: child, parent_id: parent }, fetchFn);
  if (cycle) return json({ error: "cycle_detected" }, 409);

  try {
    await insert(env, "account_parents", { child_id: child, parent_id: parent }, fetchFn);
  } catch (err) {
    if (err instanceof SupabaseError && err.status === 409) {
      return json({ error: "already_linked" }, 409);
    }
    throw err;
  }
  return json({ ok: true }, 201);
}

export async function removeParent(
  request: Request,
  env: Env,
  childId: unknown,
  parentId: unknown,
  fetchFn: FetchFn = fetch,
): Promise<Response> {
  const denied = await authorise(request, env, fetchFn);
  if (denied) return denied;

  const child = parseId(childId);
  const parent = parseId(parentId);
  if (!child || !parent) return json({ error: "invalid_id" }, 400);

  await remove(env, "account_parents", `child_id=eq.${child}&parent_id=eq.${parent}`, fetchFn);
  return json({ ok: true });
}
