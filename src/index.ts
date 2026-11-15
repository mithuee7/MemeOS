import { SupabaseEnv, SupabaseError, rpc, select } from "./supabase";

export interface Env extends SupabaseEnv {
  // Cloudflare environment variables / secrets. No D1 or R2 bindings.
}

// Parent-cycle check via the Postgres function `would_create_cycle`
// (see supabase/migrations). Returns true if the edge would create a cycle.
export async function wouldCreateCycle(
  env: Env,
  childId: number,
  parentId: number,
): Promise<boolean> {
  return rpc<boolean>(env, "would_create_cycle", {
    child_id: childId,
    parent_id: parentId,
  });
}

async function health(env: Env): Promise<Response> {
  const rows = await select<{ value: string }>(
    env,
    "global_settings",
    "select=value&key=eq.paused",
  );
  return json({ ok: true, paused: rows[0]?.value === "true" });
}

async function listAccounts(env: Env): Promise<Response> {
  const accounts = await select(
    env,
    "instagram_accounts",
    "select=id,handle,discovery_enabled,posts_per_day,audio_fallback&order=handle",
  );
  return json({ accounts });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        return await health(env);
      }
      if (request.method === "GET" && url.pathname === "/api/accounts") {
        return await listAccounts(env);
      }
      return json({ error: "not_found" }, 404);
    } catch (err) {
      // Never leak internals or secrets to the client; details belong in system_logs.
      const status = err instanceof SupabaseError ? 502 : 500;
      return json({ error: status === 502 ? "upstream_error" : "internal_error" }, status);
    }
  },

  async scheduled(_controller: ScheduledController, _env: Env): Promise<void> {
    // Automation engine entry point: will drain automation_jobs.
    // Not yet implemented.
  },
} satisfies ExportedHandler<Env>;
