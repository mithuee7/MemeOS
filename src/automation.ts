import { AuthEnv, requireAdmin } from "./auth";
import { json, readJson } from "./http";
import { ApifyProvider, ProviderNotConfigured, ingestReference } from "./discovery";
import { resolveSecret, IntegrationsEnv } from "./integrations";
import { JOB_MAX_ATTEMPTS, retryDelayMs } from "./schedule-logic";
import { SupabaseEnv, insert, patch, select } from "./supabase";

export interface AutomationEnv extends AuthEnv, IntegrationsEnv {
  APIFY_ACTOR_ID: string;
}
type FetchFn = typeof fetch;

const STALE_RUNNING_MS = 15 * 60_000;
const BATCH = 10;

export async function isPaused(env: SupabaseEnv, fetchFn: FetchFn = fetch): Promise<boolean> {
  const rows = await select<{ value: string }>(env, "global_settings", "select=value&key=eq.paused", fetchFn);
  return rows[0]?.value === "true";
}

export async function setPaused(env: SupabaseEnv, paused: boolean, fetchFn: FetchFn = fetch): Promise<void> {
  await patch(env, "global_settings", "key=eq.paused", { value: paused ? "true" : "false" }, fetchFn);
}

// Adds a job once. The idempotency key stops duplicate work when cron fires twice.
export async function enqueueJob(
  env: SupabaseEnv,
  kind: string,
  idempotencyKey: string,
  payload: Record<string, unknown>,
  fetchFn: FetchFn = fetch,
): Promise<void> {
  const res = await fetchFn(`${env.SUPABASE_URL}/rest/v1/automation_jobs?on_conflict=idempotency_key`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify({ kind, idempotency_key: idempotencyKey, payload }),
  });
  if (!res.ok) throw new Error("enqueue_failed");
}

// Enqueues a discovery job for each enabled source that is due. Each due window
// yields one key, so running cron twice in the same window adds nothing new.
export async function enqueueDueDiscovery(env: AutomationEnv, now: Date, fetchFn: FetchFn = fetch): Promise<number> {
  const refs = await select<{ id: number; discovery_interval_minutes: number; last_scraped_at: string | null }>(
    env,
    "reference_accounts",
    "select=id,discovery_interval_minutes,last_scraped_at&enabled=eq.true",
    fetchFn,
  );
  let queued = 0;
  for (const r of refs) {
    const windowMs = r.discovery_interval_minutes * 60_000;
    const last = r.last_scraped_at ? new Date(r.last_scraped_at).getTime() : 0;
    if (now.getTime() - last < windowMs) continue;
    const bucket = Math.floor(now.getTime() / windowMs);
    await enqueueJob(env, "discovery", `discovery:${r.id}:${bucket}`, { reference_id: r.id }, fetchFn);
    queued++;
  }
  return queued;
}

// Returns stuck "running" jobs (crashed worker) to the queue.
async function recoverStale(env: SupabaseEnv, now: Date, fetchFn: FetchFn) {
  const cutoff = new Date(now.getTime() - STALE_RUNNING_MS).toISOString();
  await patch(env, "automation_jobs", `status=eq.running&updated_at=lt.${encodeURIComponent(cutoff)}`, {
    status: "queued",
    next_run_at: now.toISOString(),
  }, fetchFn);
}

// Claims a job only if it is still queued. Postgres applies the filter atomically,
// so two workers can never run the same job.
async function claim(env: SupabaseEnv, job: Job, now: Date, fetchFn: FetchFn): Promise<boolean> {
  const rows = await patch(env, "automation_jobs", `id=eq.${job.id}&status=eq.queued`, {
    status: "running",
    attempts: job.attempts + 1,
    updated_at: now.toISOString(),
  }, fetchFn);
  return rows.length > 0;
}

interface Job {
  id: number;
  kind: string;
  attempts: number;
  payload: Record<string, unknown> | null;
}

// Runs one job. Permanent failures (missing configuration) are not retried.
async function runJob(env: AutomationEnv, job: Job, fetchFn: FetchFn): Promise<{ ok: true } | { ok: false; permanent: boolean; message: string }> {
  try {
    if (job.kind === "discovery") {
      const referenceId = Number(job.payload?.reference_id);
      if (!Number.isInteger(referenceId)) return { ok: false, permanent: true, message: "invalid_payload" };
      const token = await resolveSecret(env, "apify");
      const provider = new ApifyProvider({ actorId: env.APIFY_ACTOR_ID, token }, fetchFn);
      await ingestReference(env, referenceId, provider, fetchFn);
      return { ok: true };
    }
    return { ok: false, permanent: true, message: "unknown_job_kind" };
  } catch (err) {
    if (err instanceof ProviderNotConfigured) return { ok: false, permanent: true, message: "apify_not_configured" };
    const message = err instanceof Error ? err.message : "unknown_error";
    return { ok: false, permanent: false, message };
  }
}

export interface TickResult {
  paused: boolean;
  enqueued: number;
  ran: number;
  succeeded: number;
  failed: number;
}

// One pass of the engine. Safe to call from cron or manually.
export async function tick(env: AutomationEnv, now: Date = new Date(), fetchFn: FetchFn = fetch): Promise<TickResult> {
  if (await isPaused(env, fetchFn)) return { paused: true, enqueued: 0, ran: 0, succeeded: 0, failed: 0 };

  await recoverStale(env, now, fetchFn);
  const enqueued = await enqueueDueDiscovery(env, now, fetchFn);

  const due = await select<Job & { status: string }>(
    env,
    "automation_jobs",
    `select=id,kind,attempts,payload,status&status=eq.queued&next_run_at=lte.${encodeURIComponent(now.toISOString())}&order=next_run_at.asc&limit=${BATCH}`,
    fetchFn,
  );

  let succeeded = 0;
  let failed = 0;
  let ran = 0;
  for (const job of due) {
    if (!(await claim(env, job, now, fetchFn))) continue; // another worker took it
    ran++;
    const outcome = await runJob(env, job, fetchFn);
    const attemptNo = job.attempts + 1;
    if (outcome.ok) {
      succeeded++;
      await patch(env, "automation_jobs", `id=eq.${job.id}`, { status: "succeeded", last_error: null, updated_at: new Date().toISOString() }, fetchFn);
      await insert(env, "job_attempts", { job_id: job.id, attempt: attemptNo, status: "succeeded" }, fetchFn);
      continue;
    }
    failed++;
    const retry = !outcome.permanent && attemptNo < JOB_MAX_ATTEMPTS;
    await patch(env, "automation_jobs", `id=eq.${job.id}`, {
      status: retry ? "queued" : "failed",
      last_error: outcome.message,
      next_run_at: retry ? new Date(now.getTime() + retryDelayMs(attemptNo)).toISOString() : now.toISOString(),
      updated_at: new Date().toISOString(),
    }, fetchFn);
    await insert(env, "job_attempts", {
      job_id: job.id,
      attempt: attemptNo,
      status: "failed",
      error_class: outcome.permanent ? "permanent" : "transient",
      error: outcome.message,
    }, fetchFn);
  }
  return { paused: false, enqueued, ran, succeeded, failed };
}

// ---------- HTTP -----------------------------------------------------------------

async function gate(request: Request, env: AuthEnv, fetchFn: FetchFn): Promise<Response | null> {
  const auth = await requireAdmin(request, env, fetchFn);
  if (auth.ok) return null;
  return json({ error: auth.status === 401 ? "unauthorised" : "forbidden" }, auth.status);
}

export async function automationStatus(request: Request, env: AutomationEnv, fetchFn: FetchFn = fetch) {
  const denied = await gate(request, env, fetchFn);
  if (denied) return denied;
  const [paused, jobs] = await Promise.all([
    isPaused(env, fetchFn),
    select(env, "automation_jobs", "select=id,kind,status,attempts,last_error,next_run_at,updated_at&order=updated_at.desc&limit=100", fetchFn),
  ]);
  return json({ paused, jobs });
}

export async function runTickNow(request: Request, env: AutomationEnv, fetchFn: FetchFn = fetch) {
  const denied = await gate(request, env, fetchFn);
  if (denied) return denied;
  return json(await tick(env, new Date(), fetchFn));
}

export async function setPauseRoute(request: Request, env: AutomationEnv, fetchFn: FetchFn = fetch) {
  const denied = await gate(request, env, fetchFn);
  if (denied) return denied;
  const body = (await readJson(request)) as { paused?: unknown } | null;
  if (typeof body?.paused !== "boolean") return json({ error: "invalid_request" }, 400);
  await setPaused(env, body.paused, fetchFn);
  return json({ paused: body.paused });
}
