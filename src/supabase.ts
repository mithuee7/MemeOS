// Minimal Supabase REST (PostgREST) client for Cloudflare Workers.
// Uses the service-role key, which bypasses RLS. It must only ever live in
// Worker secrets (`wrangler secret put SUPABASE_SERVICE_ROLE_KEY`), never in
// frontend code or logs.

export interface SupabaseEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

export class SupabaseError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    // Deliberately omits response bodies and keys so nothing sensitive is logged.
    super(`Supabase request failed: ${status} on ${path}`);
  }
}

function headers(env: SupabaseEnv): HeadersInit {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "content-type": "application/json",
  };
}

async function request<T>(
  env: SupabaseEnv,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers(env), ...(init.headers ?? {}) },
  });
  if (!res.ok) throw new SupabaseError(res.status, path.split("?")[0]);
  return (await res.json()) as T;
}

export function select<T>(env: SupabaseEnv, table: string, query: string): Promise<T[]> {
  return request<T[]>(env, `${table}?${query}`);
}

export async function rpc<T>(
  env: SupabaseEnv,
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  return request<T>(env, `rpc/${fn}`, {
    method: "POST",
    body: JSON.stringify(args),
  });
}
