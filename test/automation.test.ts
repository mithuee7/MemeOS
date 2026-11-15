import { describe, expect, it, vi, afterEach } from "vitest";
import { tick, AutomationEnv } from "../src/automation";
import { saveAccountSettings, addSchedule, autoSchedule } from "../src/scheduler";
import worker from "../src/index";

const BASE = {
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service-secret",
  APIFY_ACTOR_ID: "actor~test",
};
// Apify token supplied as a Worker secret, so discovery jobs can run.
const ENV = { ...BASE, APIFY_TOKEN: "apify-token-123456" } as unknown as AutomationEnv;
const NO_TOKEN = { ...BASE } as unknown as AutomationEnv;

afterEach(() => vi.unstubAllGlobals());

interface World {
  paused?: boolean;
  dueJobs?: { id: number; kind: string; attempts: number; payload: unknown; status: string }[];
  claimable?: boolean; // false simulates another worker winning the claim
  refs?: { id: number; discovery_interval_minutes: number; last_scraped_at: string | null }[];
  apifyStatus?: number; // response status from the scraper
  hasToken?: boolean;
}

function world(w: World = {}) {
  const writes: { method: string; url: string; body?: Record<string, unknown> }[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== "GET") writes.push({ method, url, body });
    const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

    if (url.includes("api.apify.com")) return new Response("[]", { status: w.apifyStatus ?? 200 });
    if (url.includes("/rest/v1/global_settings")) return json([{ value: w.paused ? "true" : "false" }]);
    if (url.includes("/rest/v1/reference_accounts?select=id")) return json(w.refs ?? []);
    if (url.includes("/rest/v1/reference_accounts?select=username")) return json([{ username: "famous" }]);
    if (url.includes("/rest/v1/reference_accounts") && method === "PATCH") return json([{ id: 1 }]);
    if (url.includes("/rest/v1/integration_credentials")) return json(w.hasToken === false ? [] : [{ ciphertext: "", iv: "" }]);
    if (url.includes("/rest/v1/automation_jobs") && method === "POST") return json({}, 201);
    if (url.includes("/rest/v1/automation_jobs") && method === "PATCH") return json(w.claimable === false ? [] : [{ id: 1 }]);
    if (url.includes("/rest/v1/automation_jobs") && method === "GET") return json(w.dueJobs ?? []);
    if (url.includes("/rest/v1/job_attempts")) return json({}, 201);
    if (url.includes("/rest/v1/discovery_runs") && method === "POST") return json([{ id: 7 }], 201);
    if (url.includes("/rest/v1/discovery_runs") && method === "PATCH") return json([{ id: 7 }]);
    return json([]);
  });
  vi.stubGlobal("fetch", fetchFn);
  return { fetchFn, writes };
}

describe("global pause", () => {
  it("does nothing at all while paused", async () => {
    const { fetchFn, writes } = world({ paused: true, dueJobs: [{ id: 1, kind: "discovery", attempts: 0, payload: { reference_id: 1 }, status: "queued" }] });
    const result = await tick(ENV, new Date());
    expect(result.paused).toBe(true);
    expect(result.ran).toBe(0);
    expect(fetchFn.mock.calls.some((c) => String(c[0]).includes("api.apify.com"))).toBe(false);
    expect(writes).toEqual([]);
  });
});

describe("job claiming and retries", () => {
  const job = (attempts = 0) => [{ id: 1, kind: "discovery", attempts, payload: { reference_id: 1 }, status: "queued" }];

  it("skips a job another worker already claimed", async () => {
    const { fetchFn } = world({ dueJobs: job(), claimable: false });
    const result = await tick(ENV, new Date());
    expect(result.ran).toBe(0);
    expect(fetchFn.mock.calls.some((c) => String(c[0]).includes("api.apify.com"))).toBe(false);
  });

  it("marks a job succeeded when discovery works", async () => {
    const { writes } = world({ dueJobs: job(), refs: [] });
    const result = await tick(ENV, new Date());
    expect(result.succeeded).toBe(1);
    const done = writes.find((w) => w.url.includes("automation_jobs") && w.body?.status === "succeeded");
    expect(done).toBeDefined();
  });

  it("requeues a transient failure with a later run time", async () => {
    const now = new Date("2026-11-15T10:00:00Z");
    const { writes } = world({ dueJobs: job(0), apifyStatus: 500 });
    await tick(ENV, now);
    const retry = writes.find((w) => w.url.includes("automation_jobs") && w.body?.last_error === "apify_request_failed_500");
    expect(retry?.body?.status).toBe("queued");
    expect(new Date(String(retry!.body!.next_run_at)).getTime()).toBeGreaterThan(now.getTime());
  });

  it("gives up after the maximum number of attempts", async () => {
    const { writes } = world({ dueJobs: job(4), apifyStatus: 500 });
    await tick(ENV, new Date());
    const final = writes.find((w) => w.url.includes("automation_jobs") && w.body?.status === "failed");
    expect(final).toBeDefined();
  });

  it("does not retry a missing configuration, because waiting will not fix it", async () => {
    const { writes } = world({ dueJobs: job(0), hasToken: false });
    await tick(NO_TOKEN, new Date());
    const row = writes.find((w) => w.url.includes("automation_jobs") && w.body?.last_error === "apify_not_configured");
    expect(row?.body?.status).toBe("failed");
  });

  it("uses one job key per discovery window so cron repeats add nothing new", async () => {
    const now = new Date("2026-11-15T10:00:00Z");
    const { writes } = world({ refs: [{ id: 7, discovery_interval_minutes: 360, last_scraped_at: null }], dueJobs: [] });
    await tick(ENV, now);
    const enqueue = writes.find((w) => w.url.includes("automation_jobs") && w.method === "POST");
    const windowMs = 360 * 60_000;
    expect(enqueue?.body?.idempotency_key).toBe(`discovery:7:${Math.floor(now.getTime() / windowMs)}`);
  });

  it("does not enqueue a source that was scraped within its interval", async () => {
    const now = new Date("2026-11-15T10:00:00Z");
    const { writes } = world({ refs: [{ id: 7, discovery_interval_minutes: 360, last_scraped_at: "2026-11-15T09:00:00Z" }], dueJobs: [] });
    await tick(ENV, now);
    expect(writes.some((w) => w.url.includes("automation_jobs") && w.method === "POST")).toBe(false);
  });
});

describe("automation routes are admin-only", () => {
  it("rejects anonymous pause changes", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const res = await worker.fetch(new Request("https://w.test/api/automation/pause", { method: "PUT", body: JSON.stringify({ paused: true }) }), ENV as never);
    expect(res.status).toBe(401);
  });
});

describe("scheduler rules", () => {
  const authed = (path: string, body: unknown) => new Request(`https://w.test${path}`, {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const future = new Date(Date.now() + 86_400_000).toISOString();

  it("refuses to schedule a meme that isn't approved", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "a" }), { status: 200 });
      if (url.includes("admin_users")) return new Response(JSON.stringify([{ user_id: "a" }]), { status: 200 });
      if (url.includes("meme_assignments")) return new Response(JSON.stringify([{ id: 5, account_id: 1, approval_status: "pending" }]), { status: 200 });
      return new Response("[]", { status: 200 });
    }));
    const res = await addSchedule(authed("/api/schedule", { assignment_id: 5, scheduled_for: future }), ENV as never);
    expect(res.status).toBe(409);
  });

  it("refuses times in the past", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "a" }), { status: 200 });
      return new Response(JSON.stringify([{ user_id: "a" }]), { status: 200 });
    }));
    const res = await addSchedule(authed("/api/schedule", { assignment_id: 5, scheduled_for: "2020-01-01T00:00:00Z" }), ENV as never);
    expect(res.status).toBe(400);
  });

  it("rejects malformed daily times and unknown timezones", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "a" }), { status: 200 });
      return new Response(JSON.stringify([{ user_id: "a" }]), { status: 200 });
    }));
    const badTime = await saveAccountSettings(
      new Request("https://w.test/api/accounts/1/settings", { method: "PUT", headers: { authorization: "Bearer t" }, body: JSON.stringify({ post_times: ["25:00"], timezone: "Asia/Kolkata" }) }),
      ENV as never,
      "1",
    );
    expect(badTime.status).toBe(400);
    const badZone = await saveAccountSettings(
      new Request("https://w.test/api/accounts/1/settings", { method: "PUT", headers: { authorization: "Bearer t" }, body: JSON.stringify({ post_times: ["09:00"], timezone: "Mars/Olympus" }) }),
      ENV as never,
      "1",
    );
    expect(badZone.status).toBe(400);
  });

  it("auto-schedule only uses approved memes", async () => {
    const writes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "a" }), { status: 200 });
      if (url.includes("admin_users")) return new Response(JSON.stringify([{ user_id: "a" }]), { status: 200 });
      if (url.includes("account_settings")) return new Response("[]", { status: 200 });
      if (url.includes("meme_assignments") && url.includes("approval_status=eq.approved")) return new Response(JSON.stringify([{ id: 9 }]), { status: 200 });
      if (url.includes("publishing_schedule") && (init?.method ?? "GET") === "GET") return new Response("[]", { status: 200 });
      if (url.includes("publishing_schedule") && init?.method === "POST") { writes.push(String(init.body)); return new Response("[]", { status: 201 }); }
      return new Response("[]", { status: 200 });
    }));
    const res = await autoSchedule(new Request("https://w.test/api/schedule/auto", { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify({ account_id: 1 }) }), ENV as never);
    expect(res.status).toBe(200);
    expect(JSON.parse(writes[0])[0].assignment_id).toBe(9);
  });
});
