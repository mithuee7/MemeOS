import { describe, expect, it, vi, afterEach } from "vitest";
import worker from "../src/index";

const ENV = {
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service-secret",
  APIFY_ACTOR_ID: "actor~test",
};

afterEach(() => vi.unstubAllGlobals());

// Fake Supabase. Records writes and answers the admin check.
function fake(opts: { admin?: boolean; rows?: unknown[]; total?: number } = {}) {
  const writes: { method: string; url: string; body?: unknown }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") writes.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "admin-1" }), { status: 200 });
    if (url.includes("/rest/v1/admin_users")) return new Response(JSON.stringify(opts.admin === false ? [] : [{ user_id: "admin-1" }]), { status: 200 });
    if (method === "PATCH") return new Response(JSON.stringify([{ id: 1 }]), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(opts.rows ?? []), {
      status: 200,
      headers: { "content-range": `0-${(opts.rows?.length ?? 1) - 1}/${opts.total ?? opts.rows?.length ?? 0}`, "content-type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, writes };
}

const auth = { authorization: "Bearer t" };
const send = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://w.test${path}`, init), ENV as never);

describe("workspace routes are admin-only", () => {
  it.each([
    ["/api/approvals", "GET"],
    ["/api/approvals/bulk", "POST"],
    ["/api/approvals/5", "PATCH"],
    ["/api/memes/5", "PATCH"],
    ["/api/library", "GET"],
    ["/api/system-health", "GET"],
  ])("%s %s rejects anonymous callers", async (path, method) => {
    fake();
    const res = await send(path, { method });
    expect(res.status).toBe(401);
  });

  it("returns 403 for a signed-in non-admin", async () => {
    fake({ admin: false });
    const res = await send("/api/library", { headers: auth });
    expect(res.status).toBe(403);
  });
});

describe("approvals", () => {
  it("returns a page with the total from the content-range header", async () => {
    fake({ rows: [{ id: 1, approval_status: "pending" }], total: 240 });
    const res = await send("/api/approvals?page=2&limit=50", { headers: auth });
    const body = (await res.json()) as { total: number; page: number };
    expect(body.total).toBe(240);
    expect(body.page).toBe(2);
  });

  it("rejects an invalid status", async () => {
    fake();
    const res = await send("/api/approvals/5", { method: "PATCH", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ approval_status: "published" }) });
    expect(res.status).toBe(400);
  });

  it("approves a single assignment", async () => {
    const { writes } = fake();
    const res = await send("/api/approvals/5", { method: "PATCH", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ approval_status: "approved" }) });
    expect(res.status).toBe(200);
    expect(writes[0].url).toContain("meme_assignments?id=eq.5");
    expect(writes[0].body).toEqual({ approval_status: "approved" });
  });

  it("bulk approval targets exactly the listed assignment ids", async () => {
    const { writes } = fake({ rows: [] });
    await send("/api/approvals/bulk", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ ids: [3, 4], approval_status: "rejected" }) });
    expect(writes[0].url).toContain("id=in.(3,4)");
    expect(writes[0].body).toEqual({ approval_status: "rejected" });
  });

  it("refuses bulk requests with non-numeric or empty ids", async () => {
    fake();
    const bad = await send("/api/approvals/bulk", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ ids: ["1); drop", 2], approval_status: "approved" }) });
    expect(bad.status).toBe(400);
    const empty = await send("/api/approvals/bulk", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ ids: [], approval_status: "approved" }) });
    expect(empty.status).toBe(400);
  });

  it("refuses bulk requests above 200 items", async () => {
    fake();
    const ids = Array.from({ length: 201 }, (_, i) => i + 1);
    const res = await send("/api/approvals/bulk", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ ids, approval_status: "approved" }) });
    expect(res.status).toBe(400);
  });
});

describe("meme text editing", () => {
  it("saves edited text on the central meme, not per account", async () => {
    const { writes } = fake();
    const res = await send("/api/memes/9", { method: "PATCH", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ edited_text: "fixed line" }) });
    expect(res.status).toBe(200);
    expect(writes[0].url).toContain("/rest/v1/memes?id=eq.9");
  });

  it("rejects overly long text", async () => {
    fake();
    const res = await send("/api/memes/9", { method: "PATCH", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ edited_text: "x".repeat(2001) }) });
    expect(res.status).toBe(400);
  });
});

describe("system health", () => {
  it("does not return secret values from integrations", async () => {
    fake({ rows: [{ provider: "groq", status: "ok", last4: "9999", status_detail: "Connected." }] });
    const res = await send("/api/system-health", { headers: auth });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toMatch(/ciphertext|\biv\b|service-secret/);
  });
});
