// Minimal Supabase REST (PostgREST) client for Cloudflare Workers.
// Uses the service-role key, which bypasses RLS. It must only ever live in
// Worker secrets (`wrangler secret put SUPABASE_SERVICE_ROLE_KEY`), never in
// frontend code or logs.

export interface SupabaseEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
}

type FetchFn = typeof fetch;

export class SupabaseError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
  ) {
    // Deliberately omits response bodies and keys so nothing sensitive is logged.
    super(`Supabase request failed: ${status} on ${path}`);
  }
}

async function request<T>(
  env: SupabaseEnv,
  path: string,
  init: RequestInit = {},
  fetchFn: FetchFn = fetch,
): Promise<T> {
  const res = await fetchFn(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) throw new SupabaseError(res.status, path.split("?")[0]);
  return (await res.json()) as T;
}

export function select<T>(
  env: SupabaseEnv,
  table: string,
  query: string,
  fetchFn: FetchFn = fetch,
): Promise<T[]> {
  return request<T[]>(env, `${table}?${query}`, {}, fetchFn);
}

export function insert<T>(
  env: SupabaseEnv,
  table: string,
  row: Record<string, unknown>,
  fetchFn: FetchFn = fetch,
): Promise<T[]> {
  return request<T[]>(
    env,
    table,
    { method: "POST", body: JSON.stringify(row), headers: { Prefer: "return=representation" } },
    fetchFn,
  );
}

export function remove(
  env: SupabaseEnv,
  table: string,
  query: string,
  fetchFn: FetchFn = fetch,
): Promise<unknown> {
  return request<unknown>(
    env,
    `${table}?${query}`,
    { method: "DELETE", headers: { Prefer: "return=representation" } },
    fetchFn,
  );
}

export function rpc<T>(
  env: SupabaseEnv,
  fn: string,
  args: Record<string, unknown>,
  fetchFn: FetchFn = fetch,
): Promise<T> {
  return request<T>(env, `rpc/${fn}`, { method: "POST", body: JSON.stringify(args) }, fetchFn);
}
