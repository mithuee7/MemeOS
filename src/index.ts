import { Env, addParent, createAccount, json, listAccounts, removeParent } from "./accounts";
import { select } from "./supabase";

export type { Env };

async function health(env: Env): Promise<Response> {
  // Public endpoint: reports only liveness and the global pause flag.
  const rows = await select<{ value: string }>(env, "global_settings", "select=value&key=eq.paused");
  return json({ ok: true, paused: rows[0]?.value === "true" });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;
    try {
      if (method === "GET" && pathname === "/api/health") return await health(env);

      if (pathname === "/api/accounts") {
        if (method === "GET") return await listAccounts(request, env);
        if (method === "POST") return await createAccount(request, env);
        return json({ error: "method_not_allowed" }, 405);
      }

      const parents = /^\/api\/accounts\/(\d+)\/parents(?:\/(\d+))?$/.exec(pathname);
      if (parents) {
        const [, childId, parentId] = parents;
        if (method === "POST" && !parentId) return await addParent(request, env, childId);
        if (method === "DELETE" && parentId) return await removeParent(request, env, childId, parentId);
        return json({ error: "method_not_allowed" }, 405);
      }

      return json({ error: "not_found" }, 404);
    } catch {
      // Never leak internals or secrets to the client; details belong in system_logs.
      return json({ error: "internal_error" }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, _env: Env): Promise<void> {
    // Automation engine entry point (Stage 7). Not yet implemented.
  },
} satisfies ExportedHandler<Env>;
