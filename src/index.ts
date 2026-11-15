import { Env as AccountsEnv, addParent, createAccount, json, listAccounts, removeParent } from "./accounts";
import { select } from "./supabase";
import { WorkspaceEnv } from "./workspace";
import { routeWorkspace } from "./workspace-routes";
import { routeAutomation } from "./automation-routes";
import { tick, AutomationEnv } from "./automation";
import { SchedulerEnv } from "./scheduler";
import { IntegrationsEnv, checkIntegration, deleteIntegration, listIntegrations, saveIntegration } from "./integrations";
import { ReferencesEnv, createReference, deleteReference, listReferences, runReferenceDiscovery, updateReference } from "./references";

export interface Env extends AccountsEnv, ReferencesEnv, IntegrationsEnv, WorkspaceEnv, AutomationEnv, SchedulerEnv {
  ASSETS: Fetcher;
}

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

      if (pathname === "/api/integrations" && method === "GET") return await listIntegrations(request, env);
      const integ = /^\/api\/integrations\/([a-z]+)(\/test)?$/.exec(pathname);
      if (integ) {
        const [, provider, test] = integ;
        if (test && method === "POST") return await checkIntegration(request, env, provider);
        if (!test && method === "PUT") return await saveIntegration(request, env, provider);
        if (!test && method === "DELETE") return await deleteIntegration(request, env, provider);
        return json({ error: "method_not_allowed" }, 405);
      }

      if (pathname === "/api/references") {
        if (method === "GET") return await listReferences(request, env);
        if (method === "POST") return await createReference(request, env);
        return json({ error: "method_not_allowed" }, 405);
      }
      const ref = /^\/api\/references\/(\d+)(\/discover)?$/.exec(pathname);
      if (ref) {
        const [, id, discover] = ref;
        if (discover && method === "POST") return await runReferenceDiscovery(request, env, id);
        if (!discover && method === "PATCH") return await updateReference(request, env, id);
        if (!discover && method === "DELETE") return await deleteReference(request, env, id);
        return json({ error: "method_not_allowed" }, 405);
      }

      const automation = await routeAutomation(request, env, pathname, method);
      if (automation) return automation;
      const workspace = await routeWorkspace(request, env, pathname, method);
      if (workspace) return workspace;

      if (pathname.startsWith("/api/")) return json({ error: "not_found" }, 404);

      // Website: serve the built asset when it exists, otherwise the app shell so
      // client-side routes work on reload.
      if (method === "GET" || method === "HEAD") {
        const asset = await env.ASSETS.fetch(request);
        // Assets answer unknown paths with 404 or a redirect to "/"; either way the
        // app shell is what the client router needs.
        if (asset.status === 200) return asset;
        return env.ASSETS.fetch(new Request(new URL("/", url), request));
      }
      return json({ error: "not_found" }, 404);
    } catch {
      // Never leak internals or secrets to the client; details belong in system_logs.
      return json({ error: "internal_error" }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    // Cron entry point: queues due discovery and runs a batch of jobs. Respects global pause.
    await tick(env, new Date());
  },
} satisfies ExportedHandler<Env>;
