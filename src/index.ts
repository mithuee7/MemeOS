export interface Env {
  MEMEOS_DB: D1Database;
  MEDIA: R2Bucket;
}

// Parent-cycle check: returns true if making `parentId` a parent of `childId`
// would create a cycle, i.e. childId is already an ancestor of parentId.
export async function wouldCreateCycle(
  db: D1Database,
  childId: number,
  parentId: number,
): Promise<boolean> {
  if (childId === parentId) return true;
  const rows = await db
    .prepare(
      `WITH RECURSIVE ancestors(id) AS (
         SELECT parent_id FROM account_parents WHERE child_id = ?
         UNION
         SELECT ap.parent_id FROM account_parents ap JOIN ancestors a ON ap.child_id = a.id
       )
       SELECT 1 FROM ancestors WHERE id = ? LIMIT 1`,
    )
    .bind(parentId, childId)
    .all();
  return rows.results.length > 0;
}

async function health(env: Env): Promise<Response> {
  const paused = await env.MEMEOS_DB.prepare(
    "SELECT value FROM global_settings WHERE key = 'paused'",
  ).first<{ value: string }>();
  return json({ ok: true, paused: paused?.value === "true" });
}

async function listAccounts(env: Env): Promise<Response> {
  const { results } = await env.MEMEOS_DB.prepare(
    `SELECT id, handle, discovery_enabled, posts_per_day, audio_fallback
     FROM instagram_accounts ORDER BY handle`,
  ).all();
  return json({ accounts: results });
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
    } catch {
      // Never leak internals to the client; detailed errors belong in system_logs.
      return json({ error: "internal_error" }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, _env: Env): Promise<void> {
    // Automation engine entry point: will drain automation_jobs (discovery,
    // generation, audio matching, publishing). Not yet implemented.
  },
} satisfies ExportedHandler<Env>;
