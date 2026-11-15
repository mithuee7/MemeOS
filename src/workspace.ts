import { AuthEnv, requireAdmin } from "./auth";
import { json, readJson } from "./http";
import { SupabaseEnv, patch, select } from "./supabase";
import { parseId } from "./validation";

export interface WorkspaceEnv extends AuthEnv {}
type FetchFn = typeof fetch;

const APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;
const MEME_STATUSES = ["discovered", "extracted", "rejected_unsuitable", "needs_review", "rendered", "failed"] as const;

async function gate(request: Request, env: AuthEnv, fetchFn: FetchFn): Promise<Response | null> {
  const auth = await requireAdmin(request, env, fetchFn);
  if (auth.ok) return null;
  return json({ error: auth.status === 401 ? "unauthorised" : "forbidden" }, auth.status);
}

function pageParams(url: URL): { limit: number; offset: number } {
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 100);
  const page = Math.max(Number(url.searchParams.get("page") ?? 1) || 1, 1);
  return { limit, offset: (page - 1) * limit };
}

// Fetches one page and the total count, using PostgREST's exact count header.
async function pageOf<T>(env: SupabaseEnv, table: string, query: string, limit: number, offset: number, fetchFn: FetchFn) {
  const res = await fetchFn(`${env.SUPABASE_URL}/rest/v1/${table}?${query}&limit=${limit}&offset=${offset}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: "count=exact",
    },
  });
  if (!res.ok) throw new Error(`query_failed_${res.status}`);
  const range = res.headers.get("content-range") ?? "*/0";
  const total = Number(range.split("/")[1] ?? 0);
  return { rows: (await res.json()) as T[], total };
}

// ---------- Approval queue ----------------------------------------------------

export async function listApprovals(request: Request, env: WorkspaceEnv, fetchFn: FetchFn = fetch): Promise<Response> {
  const denied = await gate(request, env, fetchFn);
  if (denied) return denied;
  const url = new URL(request.url);
  const { limit, offset } = pageParams(url);

  const filters: string[] = [];
  const status = url.searchParams.get("status");
  if (status && (APPROVAL_STATUSES as readonly string[]).includes(status)) filters.push(`approval_status=eq.${status}`);
  const account = parseId(url.searchParams.get("account_id"));
  if (account) filters.push(`account_id=eq.${account}`);
  const memeStatus = url.searchParams.get("meme_status");
  // Meme-level filters are applied after the page is fetched, so they only
  // narrow results the database returned; see the UI note on search.
  const query = [
    "select=id,account_id,approval_status,media_type,audio_status,created_at,",
    "account:instagram_accounts(id,handle),",
    "meme:memes(id,origin,status,extracted_text,edited_text,created_at,",
    "source:source_posts(permalink,caption,post_type,discovered_at,reference:reference_accounts(username)))",
    `&order=created_at.desc${filters.length ? "&" + filters.join("&") : ""}`,
  ].join("");

  const { rows, total } = await pageOf<Record<string, unknown>>(env, "meme_assignments", query, limit, offset, fetchFn);
  const items = memeStatus && (MEME_STATUSES as readonly string[]).includes(memeStatus)
    ? rows.filter((r) => (r.meme as { status?: string } | null)?.status === memeStatus)
    : rows;
  return json({ items, total, page: Math.floor(offset / limit) + 1, limit });
}

export async function setApprovalStatus(request: Request, env: WorkspaceEnv, idRaw: string, fetchFn: FetchFn = fetch): Promise<Response> {
  const denied = await gate(request, env, fetchFn);
  if (denied) return denied;
  const id = parseId(idRaw);
  const body = (await readJson(request)) as { approval_status?: unknown } | null;
  const next = body?.approval_status;
  if (!id || typeof next !== "string" || !(APPROVAL_STATUSES as readonly string[]).includes(next)) {
    return json({ error: "invalid_request" }, 400);
  }
  const rows = await patch(env, "meme_assignments", `id=eq.${id}`, { approval_status: next }, fetchFn);
  if (rows.length === 0) return json({ error: "not_found" }, 404);
  return json({ ok: true });
}

export async function bulkApprovals(request: Request, env: WorkspaceEnv, fetchFn: FetchFn = fetch): Promise<Response> {
  const denied = await gate(request, env, fetchFn);
  if (denied) return denied;
  const body = (await readJson(request)) as { ids?: unknown; approval_status?: unknown } | null;
  const next = body?.approval_status;
  if (typeof next !== "string" || !(APPROVAL_STATUSES as readonly string[]).includes(next)) return json({ error: "invalid_request" }, 400);
  if (!Array.isArray(body?.ids) || body.ids.length === 0 || body.ids.length > 200) return json({ error: "invalid_ids" }, 400);
  const ids = body.ids.map(parseId);
  if (ids.some((x) => x === null)) return json({ error: "invalid_ids" }, 400);
  const rows = await patch(env, "meme_assignments", `id=in.(${ids.join(",")})`, { approval_status: next }, fetchFn);
  return json({ ok: true, updated: rows.length });
}

// Editing the extracted text changes the central meme, so every account sees it.
export async function editMemeText(request: Request, env: WorkspaceEnv, idRaw: string, fetchFn: FetchFn = fetch): Promise<Response> {
  const denied = await gate(request, env, fetchFn);
  if (denied) return denied;
  const id = parseId(idRaw);
  const body = (await readJson(request)) as { edited_text?: unknown } | null;
  if (!id || typeof body?.edited_text !== "string" || body.edited_text.length > 2000) return json({ error: "invalid_request" }, 400);
  const rows = await patch(env, "memes", `id=eq.${id}`, { edited_text: body.edited_text, updated_at: new Date().toISOString() }, fetchFn);
  if (rows.length === 0) return json({ error: "not_found" }, 404);
  return json({ ok: true });
}

// ---------- Content library ----------------------------------------------------

export async function listLibrary(request: Request, env: WorkspaceEnv, fetchFn: FetchFn = fetch): Promise<Response> {
  const denied = await gate(request, env, fetchFn);
  if (denied) return denied;
  const url = new URL(request.url);
  const { limit, offset } = pageParams(url);
  const query = [
    "select=id,origin,status,failure_reason,extracted_text,edited_text,original_text,created_at,",
    "source:source_posts(permalink,caption,post_type,discovered_at,reference:reference_accounts(username)),",
    "assignments:meme_assignments(account_id,approval_status,account:instagram_accounts(handle))",
    "&order=created_at.desc",
  ].join("");
  const { rows, total } = await pageOf<Record<string, unknown>>(env, "memes", query, limit, offset, fetchFn);
  return json({ items: rows, total, page: Math.floor(offset / limit) + 1, limit });
}

// ---------- System health ------------------------------------------------------

export async function systemHealth(request: Request, env: WorkspaceEnv, fetchFn: FetchFn = fetch): Promise<Response> {
  const denied = await gate(request, env, fetchFn);
  if (denied) return denied;
  const url = new URL(request.url);
  const severity = url.searchParams.get("severity");

  const [runs, logs, jobs, integrations] = await Promise.all([
    select(env, "discovery_runs", "select=id,reference_id,status,new_posts,error,started_at,finished_at,reference:reference_accounts(username)&order=started_at.desc&limit=50", fetchFn),
    select(env, "system_logs", `select=id,severity,workflow,account_id,message,created_at&order=created_at.desc&limit=100${severity ? `&severity=eq.${encodeURIComponent(severity)}` : ""}`, fetchFn),
    select(env, "automation_jobs", "select=id,kind,status,attempts,last_error,next_run_at,updated_at&status=in.(failed,paused)&order=updated_at.desc&limit=50", fetchFn),
    select(env, "integration_credentials", "select=provider,status,status_detail,last4,tested_at", fetchFn),
  ]);

  const paused = (await select<{ value: string }>(env, "global_settings", "select=value&key=eq.paused", fetchFn))[0]?.value === "true";
  return json({
    database: { ok: true },
    paused,
    integrations,
    discovery_runs: runs,
    logs,
    failed_jobs: jobs,
  });
}

export type { SupabaseEnv };
