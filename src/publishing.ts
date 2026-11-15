import { AuthEnv, requireAdmin } from "./auth";
import { json } from "./http";
import { SupabaseEnv, select } from "./supabase";

export interface PublishingEnv extends AuthEnv {}
type FetchFn = typeof fetch;

// Admin-only read of publish attempts, newest first. Nothing here is fabricated: rows come from publish_records.
export async function listPublishHistory(request: Request, env: PublishingEnv, fetchFn: FetchFn = fetch): Promise<Response> {
  const auth = await requireAdmin(request, env, fetchFn);
  if (!auth.ok) return json({ error: auth.status === 401 ? "unauthorised" : "forbidden" }, auth.status);
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 100);
  const status = url.searchParams.get("status");
  const allowed = ["pending", "publishing", "published", "failed"];
  const filter = status && allowed.includes(status) ? `&status=eq.${status}` : "";
  const query = [
    "select=id,status,attempts,permalink,error,published_at,created_at,",
    "assignment:meme_assignments(account:instagram_accounts(handle),meme:memes(edited_text,extracted_text))",
    `&order=created_at.desc&limit=${limit}${filter}`,
  ].join("");
  const rows = await select<Record<string, unknown>>(env as SupabaseEnv, "publish_records", query, fetchFn);
  return json({ items: rows });
}
