import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { parseHandle, parseId } from "../src/validation";

// Fake Supabase: records every call and answers from in-memory state, so the
// real Worker code (auth, validation, cycle check, error mapping) runs end to end.
interface Call { url: string; method: string; body?: unknown; headers: Record<string, string> }

const ENV = {
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_ANON_KEY: "anon-test-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
};

interface FakeState {
  validTokens: Record<string, string>; // token -> user id
  admins: string[];
  insertStatus?: number; // force a status on inserts (e.g. 409)
  cycle?: boolean;
}

function makeFake(state: FakeState) {
  const calls: Call[] = [];
  const fake = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body, headers });

    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

    if (url.endsWith("/auth/v1/user")) {
      const token = (headers.authorization ?? "").replace("Bearer ", "");
      const id = state.validTokens[token];
      return id ? json({ id }) : json({ error: "invalid" }, 401);
    }
    if (url.includes("/rest/v1/admin_users")) {
      const id = decodeURIComponent(/user_id=eq\.([^&]+)/.exec(url)?.[1] ?? "");
      return json(state.admins.includes(id) ? [{ user_id: id }] : []);
    }
    if (url.includes("/rest/v1/rpc/would_create_cycle")) return json(state.cycle ?? false);
    if (url.includes("/rest/v1/instagram_accounts") && method === "POST") {
      if (state.insertStatus) return json({ message: "conflict" }, state.insertStatus);
      return json([{ id: 1, ...(body as object) }], 201);
    }
    if (url.includes("/rest/v1/account_parents") && method === "POST") {
      if (state.insertStatus) return json({ message: "conflict" }, state.insertStatus);
      return json([body], 201);
    }
    if (url.includes("/rest/v1/instagram_accounts")) return json([{ id: 1, handle: "a" }]);
    if (url.includes("/rest/v1/global_settings")) return json([{ value: "false" }]);
    if (url.includes("/rest/v1/account_parents") && method === "DELETE") return json([]);
    return json({ message: "unexpected" }, 500);
  });
  return { fake, calls };
}

const ADMIN_TOKEN = "admin-token";
const USER_TOKEN = "user-token";

function req(path: string, init: RequestInit & { token?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const { token: _t, ...rest } = init;
  return new Request(`https://worker.test${path}`, { ...rest, headers });
}

let state: FakeState;
beforeEach(() => {
  state = {
    validTokens: { [ADMIN_TOKEN]: "admin-1", [USER_TOKEN]: "user-1" },
    admins: ["admin-1"],
  };
});
afterEach(() => vi.unstubAllGlobals());

function use(s: FakeState) {
  const { fake, calls } = makeFake(s);
  vi.stubGlobal("fetch", fake);
  return { calls };
}

describe("public health endpoint", () => {
  it("reports liveness and pause state without auth", async () => {
    use(state);
    const res = await worker.fetch(req("/api/health"), ENV as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, paused: false });
  });
});

describe("authentication and admin authorisation", () => {
  it("rejects a request with no bearer token (401)", async () => {
    use(state);
    const res = await worker.fetch(req("/api/accounts"), ENV as never);
    expect(res.status).toBe(401);
  });

  it("rejects an invalid token (401)", async () => {
    use(state);
    const res = await worker.fetch(req("/api/accounts", { token: "forged" }), ENV as never);
    expect(res.status).toBe(401);
  });

  it("rejects a valid but non-admin user (403)", async () => {
    use(state);
    const res = await worker.fetch(req("/api/accounts", { token: USER_TOKEN }), ENV as never);
    expect(res.status).toBe(403);
  });

  it("allows an admin to list accounts (200)", async () => {
    use(state);
    const res = await worker.fetch(req("/api/accounts", { token: ADMIN_TOKEN }), ENV as never);
    expect(res.status).toBe(200);
    expect((await res.json()).accounts).toHaveLength(1);
  });

  it("never sends the service-role key to the auth endpoint", async () => {
    const { calls } = use(state);
    await worker.fetch(req("/api/accounts", { token: ADMIN_TOKEN }), ENV as never);
    const authCall = calls.find((c) => c.url.endsWith("/auth/v1/user"))!;
    expect(JSON.stringify(authCall.headers)).not.toContain("service-test-key");
  });

  it("does not write when the caller is not an admin", async () => {
    const { calls } = use(state);
    await worker.fetch(
      req("/api/accounts", { method: "POST", token: USER_TOKEN, body: JSON.stringify({ handle: "x" }) }),
      ENV as never,
    );
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/rest/v1/"))).toBe(false);
  });
});

describe("account creation", () => {
  it("rejects an invalid handle without touching the database", async () => {
    const { calls } = use(state);
    const res = await worker.fetch(
      req("/api/accounts", { method: "POST", token: ADMIN_TOKEN, body: JSON.stringify({ handle: "bad handle!" }) }),
      ENV as never,
    );
    expect(res.status).toBe(400);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("normalises and stores a valid handle (201)", async () => {
    const { calls } = use(state);
    const res = await worker.fetch(
      req("/api/accounts", { method: "POST", token: ADMIN_TOKEN, body: JSON.stringify({ handle: "@Some.Handle" }) }),
      ENV as never,
    );
    expect(res.status).toBe(201);
    const insert = calls.find((c) => c.method === "POST" && c.url.includes("instagram_accounts"))!;
    expect(insert.body).toEqual({ handle: "some.handle" });
  });

  it("returns 409 for a duplicate handle", async () => {
    use({ ...state, insertStatus: 409 });
    const res = await worker.fetch(
      req("/api/accounts", { method: "POST", token: ADMIN_TOKEN, body: JSON.stringify({ handle: "dup" }) }),
      ENV as never,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "handle_exists" });
  });

  it("returns a generic 500 on unexpected failures and leaks no details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom with secret service-test-key"); }));
    const res = await worker.fetch(req("/api/accounts", { token: ADMIN_TOKEN }), ENV as never);
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).not.toContain("service-test-key");
    expect(text).not.toContain("boom");
  });
});

describe("parent relationships and cycle prevention", () => {
  it("rejects a self-parent (400)", async () => {
    const { calls } = use(state);
    const res = await worker.fetch(
      req("/api/accounts/5/parents", { method: "POST", token: ADMIN_TOKEN, body: JSON.stringify({ parent_id: 5 }) }),
      ENV as never,
    );
    expect(res.status).toBe(400);
    expect(calls.some((c) => c.url.includes("account_parents"))).toBe(false);
  });

  it("blocks a parent edge that would create a cycle (409) and does not insert it", async () => {
    const { calls } = use({ ...state, cycle: true });
    const res = await worker.fetch(
      req("/api/accounts/1/parents", { method: "POST", token: ADMIN_TOKEN, body: JSON.stringify({ parent_id: 2 }) }),
      ENV as never,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "cycle_detected" });
    expect(calls.some((c) => c.method === "POST" && c.url.includes("account_parents"))).toBe(false);
  });

  it("adds a valid parent edge (201)", async () => {
    const { calls } = use(state);
    const res = await worker.fetch(
      req("/api/accounts/1/parents", { method: "POST", token: ADMIN_TOKEN, body: JSON.stringify({ parent_id: 2 }) }),
      ENV as never,
    );
    expect(res.status).toBe(201);
    const rpc = calls.find((c) => c.url.includes("would_create_cycle"))!;
    expect(rpc.body).toEqual({ child_id: 1, parent_id: 2 });
  });

  it("does not route non-numeric account ids (404)", async () => {
    use(state);
    const res = await worker.fetch(
      req("/api/accounts/abc/parents", { method: "POST", token: ADMIN_TOKEN, body: JSON.stringify({ parent_id: 2 }) }),
      ENV as never,
    );
    expect(res.status).toBe(404); // route does not match non-numeric ids
  });

  it("requires admin to remove a parent edge", async () => {
    const { calls } = use(state);
    const res = await worker.fetch(req("/api/accounts/1/parents/2", { method: "DELETE", token: USER_TOKEN }), ENV as never);
    expect(res.status).toBe(403);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});

describe("input validation helpers", () => {
  it.each([
    ["Good.Name_1", "good.name_1"],
    ["@ok", "ok"],
  ])("accepts %s", (input, expected) => {
    expect(parseHandle(input)).toBe(expected);
  });

  it.each(["", "a b", "toolongtoolongtoolongtoolongtoolong", ".dot", "dot.", "a..b", "emoji😀", 42, null])(
    "rejects %s",
    (input) => {
      expect(parseHandle(input)).toBeNull();
    },
  );

  it("parseId accepts positive integers only", () => {
    expect(parseId(3)).toBe(3);
    expect(parseId("7")).toBe(7);
    expect(parseId(0)).toBeNull();
    expect(parseId("-1")).toBeNull();
    expect(parseId("1.5")).toBeNull();
  });
});
