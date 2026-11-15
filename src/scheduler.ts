import { AuthEnv, requireAdmin } from "./auth";
import { json, readJson } from "./http";
import { nextSlots } from "./schedule-logic";
import { SupabaseEnv, insert, insertIgnoreDuplicates, patch, remove, select } from "./supabase";
import { parseId } from "./validation";

export interface SchedulerEnv extends AuthEnv {}
type FetchFn = typeof fetch;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

async function gate(request: Request, env: AuthEnv, fetchFn: FetchFn): Promise<Response | null> {
  const auth = await requireAdmin(request, env, fetchFn);
  if (auth.ok) return null;
  return json({ error: auth.status === 401 ? "unauthorised" : "forbidden" }, auth.status);
}

// Per-account publishing times and timezone.
async function accountSettings(env: SupabaseEnv, accountId: number, fetchFn: FetchFn) {
  const [row] = await select<{ post_times: string[]; timezone: string }>(
    env,
    "account_settings",
    `select=post_times,timezone&account_id=eq.${accountId}`,
    fetchFn,
  );
  return row ?? { post_times: ["09:00", "13:00", "18:30"], timezone: "Asia/Kolkata" };
}

export async function getAccountSettings(request: Request, env: SchedulerEnv, idRaw: string, fetchFn: FetchFn = fetch) {
  const denied = await gate(request, env, fetchFn);
  if (denied) return denied;
  const id = parseId(idRaw);
  if (!id) return json({ error: "invalid_id" }, 400);
  return json({ settings: await accountSettings(env, id, fetchFn) });
}

export async function saveAccountSettings(request: Request, env: SchedulerEnv, idRaw: string, fetchFn: FetchFn = fetch) {
  const denied = await gate(request, env, fetchFn);
  if (denied) return denied;
  const id = parseId(idRaw);
  if (!id) return json({ error: "invalid_id" }, 400);
  const body = (await readJson(request)) as { post_times?: unknown; timezone?: unknown } | null;
  if (!Array.isArray(body?.post_times) || body.post_times.length > 10) return json({ error: "invalid_times" }, 400);
  const times = [...new Set(body.post_times)];
  if (!times.every((t) => typeof t === "string" && TIME_RE.test(t))) return json({ error: "invalid_times" }, 400);
  if (!validTimeZone(body.timezone)) return json({ error: "invalid_timezone" }, 400);
  await insert(env, "account_settings", {
    account_id: id,
    post_times: times.sort(),
    timezone: body.timezone,
    updated_at: new Date().toISOString(),
  }, fetchFn).catch(() => undefined); // conflict means it exists; patch below
  await patch(env, "account_settings", `account_id=eq.${id}`, {
    post_times: times.sort(),
    timezone: body.timezone,
    updated_at: new Date().toISOString(),
  }, fetchFn);
  return json({ ok: true });
}

// Lists scheduled posts in a time range, joined to the meme and account.
export async function listSchedule(request: Request, env: SchedulerEnv, fetchFn: FetchFn = fetch) {
  const denied = await gate(request, env, fetchFn);
  if (denied) return denied;
  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? new Date().toISOString();
  const to = url.searchParams.get("to") ?? new Date(Date.now() + 14 * 86_400_000).toISOString();
  const accountId = parseId(url.searchParams.get("account_id"));
  const query = [
    "select=id,assignment_id,account_id,scheduled_for,status,attempts,last_error,",
    "assignment:meme_assignments(id,approval_status,media_type,meme:memes(id,extracted_text,edited_text)),",
    "account:instagram_accounts(id,handle)",
    `&scheduled_for=gte.${encodeURIComponent(from)}&scheduled_for=lt.${encodeURIComponent(to)}`,
    accountId ? `&account_id=eq.${accountId}` : "",
    "&order=scheduled_for.asc&limit=500",
  ].join("");
  return json({ items: await select(env, "publishing_schedule", query, fetchFn) });
}

// Schedules one approved assignment at a specific time.
export async function addSchedule(request: Request, env: SchedulerEnv, fetchFn: FetchFn = fetch) {
  const denied = await gate(request, env, fetchFn);
  if (denied) return denied;
  const body = (await readJson(request)) as { assignment_id?: unknown; scheduled_for?: unknown } | null;
  const assignmentId = parseId(body?.assignment_id);
  const when = typeof body?.scheduled_for === "string" ? new Date(body.scheduled_for) : null;
  if (!assignmentId || !when || Number.isNaN(when.getTime())) return json({ error: "invalid_request" }, 400);
  if (when.getTime() <= Date.now()) return json({ error: "time_in_past" }, 400);

  const [assignment] = await select<{ id: number; account_id: number; approval_status: string }>(
    env,
    "meme_assignments",
    `select=id,account_id,approval_status&id=eq.${assignmentId}`,
    fetchFn,
  );
  if (!assignment) return json({ error: "not_found" }, 404);
  if (assignment.approval_status !== "approved") return json({ error: "not_approved" }, 409);

  const existing = await select(env, "publishing_schedule", `select=id&assignment_id=eq.${assignmentId}`, fetchFn);
  if (existing.length > 0) return json({ error: "already_scheduled" }, 409);

  await insert(env, "publishing_schedule", {
    assignment_id: assignment.id,
    account_id: assignment.account_id,
    scheduled_for: when.toISOString(),
    status: "scheduled",
  }, fetchFn);
  return json({ ok: true }, 201);
}

// Moves a scheduled post. Only posts that haven't started can move.
export async function rescheduleItem(request: Request, env: SchedulerEnv, idRaw: string, fetchFn: FetchFn = fetch) {
  const denied = await gate(request, env, fetchFn);
  if (denied) return denied;
  const id = parseId(idRaw);
  const body = (await readJson(request)) as { scheduled_for?: unknown } | null;
  const when = typeof body?.scheduled_for === "string" ? new Date(body.scheduled_for) : null;
  if (!id || !when || Number.isNaN(when.getTime())) return json({ error: "invalid_request" }, 400);
  if (when.getTime() <= Date.now()) return json({ error: "time_in_past" }, 400);
  const rows = await patch(env, "publishing_schedule", `id=eq.${id}&status=eq.scheduled`, { scheduled_for: when.toISOString() }, fetchFn);
  if (rows.length === 0) return json({ error: "not_movable" }, 409);
  return json({ ok: true });
}

// Cancels a scheduled post. The meme stays approved and can be scheduled again.
export async function cancelItem(request: Request, env: SchedulerEnv, idRaw: string, fetchFn: FetchFn = fetch) {
  const denied = await gate(request, env, fetchFn);
  if (denied) return denied;
  const id = parseId(idRaw);
  if (!id) return json({ error: "invalid_id" }, 400);
  const rows = await remove(env, "publishing_schedule", `id=eq.${id}&status=eq.scheduled`, fetchFn) as unknown[];
  if (!rows || rows.length === 0) return json({ error: "not_cancellable" }, 409);
  return json({ ok: true });
}

// Fills the next free slots for an account with its approved, unscheduled memes.
export async function autoSchedule(request: Request, env: SchedulerEnv, fetchFn: FetchFn = fetch) {
  const denied = await gate(request, env, fetchFn);
  if (denied) return denied;
  const body = (await readJson(request)) as { account_id?: unknown } | null;
  const accountId = parseId(body?.account_id);
  if (!accountId) return json({ error: "invalid_request" }, 400);

  const settings = await accountSettings(env, accountId, fetchFn);
  const pending = await select<{ id: number }>(
    env,
    "meme_assignments",
    `select=id&account_id=eq.${accountId}&approval_status=eq.approved&order=created_at.asc&limit=200`,
    fetchFn,
  );
  const scheduled = await select<{ assignment_id: number }>(env, "publishing_schedule", `select=assignment_id&account_id=eq.${accountId}`, fetchFn);
  const alreadyScheduled = new Set(scheduled.map((s) => s.assignment_id));
  const unscheduled = pending.filter((p) => !alreadyScheduled.has(p.id));
  if (unscheduled.length === 0) return json({ ok: true, scheduled: 0 });

  const existingTimes = await select<{ scheduled_for: string }>(env, "publishing_schedule", `select=scheduled_for&account_id=eq.${accountId}`, fetchFn);
  const taken = new Set(existingTimes.map((r) => new Date(r.scheduled_for).getTime()));
  const slots = nextSlots({
    from: new Date(),
    times: settings.post_times,
    timeZone: settings.timezone,
    count: unscheduled.length,
    taken,
  });

  const rows = unscheduled.slice(0, slots.length).map((a, i) => ({
    assignment_id: a.id,
    account_id: accountId,
    scheduled_for: slots[i].toISOString(),
    status: "scheduled",
  }));
  if (rows.length > 0) await insertIgnoreDuplicates(env, "publishing_schedule", rows, "assignment_id", fetchFn);
  return json({ ok: true, scheduled: rows.length });
}

export type { SupabaseEnv };
