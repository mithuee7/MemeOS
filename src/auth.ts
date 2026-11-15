import { SupabaseEnv, select } from "./supabase";

export interface AuthEnv extends SupabaseEnv {
  SUPABASE_ANON_KEY: string;
}

export type AuthResult =
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 403 };

type FetchFn = typeof fetch;

// Verifies the caller's Supabase Auth access token by asking Supabase Auth
// who it belongs to, then checks the admin allow-list. The token is never
// logged or stored.
export async function requireAdmin(
  request: Request,
  env: AuthEnv,
  fetchFn: FetchFn = fetch,
): Promise<AuthResult> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) return { ok: false, status: 401 };

  const userRes = await fetchFn(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      authorization: `Bearer ${match[1]}`,
    },
  });
  if (!userRes.ok) return { ok: false, status: 401 };

  const user = (await userRes.json()) as { id?: unknown };
  if (typeof user.id !== "string") return { ok: false, status: 401 };

  const rows = await select<{ user_id: string }>(
    { SUPABASE_URL: env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY },
    "admin_users",
    `select=user_id&user_id=eq.${encodeURIComponent(user.id)}`,
    fetchFn,
  );
  if (rows.length === 0) return { ok: false, status: 403 };

  return { ok: true, userId: user.id };
}
