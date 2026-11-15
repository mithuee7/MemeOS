import { describe, expect, it, vi } from "vitest";
import { mapApifyItem, ingestReference, ApifyProvider, ProviderError, SourceProvider } from "../src/discovery";
import worker from "../src/index";
import { accountsForReference } from "../src/discovery";

const ENV = {
  SUPABASE_URL: "https://test.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  SUPABASE_SERVICE_ROLE_KEY: "service-secret",
  APIFY_ACTOR_ID: "actor~test",
  APIFY_TOKEN: "apify-secret",
};

describe("mapApifyItem", () => {
  it("maps an image post", () => {
    expect(
      mapApifyItem({ id: "123", url: "https://www.instagram.com/p/ABC/", type: "Image", caption: "hi" }),
    ).toEqual({ providerPostId: "123", permalink: "https://www.instagram.com/p/ABC/", postType: "photo", caption: "hi" });
  });

  it("maps carousels and unknown types without guessing", () => {
    expect(mapApifyItem({ id: 1, url: "https://instagram.com/p/x/", type: "Sidecar" })?.postType).toBe("carousel");
    expect(mapApifyItem({ id: 2, url: "https://instagram.com/p/y/", type: "Mystery" })?.postType).toBe("unknown");
  });

  it("keeps videos as 'other' because Reel vs video is not in the output", () => {
    expect(mapApifyItem({ id: 3, url: "https://instagram.com/reel/z/", type: "Video" })?.postType).toBe("other");
  });

  it("rejects items without a stable id or an Instagram permalink", () => {
    expect(mapApifyItem({ url: "https://www.instagram.com/p/a/" })).toBeNull();
    expect(mapApifyItem({ id: "9", url: "https://evil.example/p/a" })).toBeNull();
  });
});

describe("ApifyProvider", () => {
  it("does not call Apify without a token", async () => {
    const fetchFn = vi.fn();
    const provider = new ApifyProvider({ actorId: ENV.APIFY_ACTOR_ID, token: null }, fetchFn as never);
    await expect(provider.fetchRecentPosts("someone", 5)).rejects.toThrow("apify_not_configured");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reports status codes only, never the token-bearing URL", async () => {
    const fetchFn = vi.fn(async () => new Response("nope", { status: 429 }));
    const provider = new ApifyProvider({ actorId: ENV.APIFY_ACTOR_ID, token: ENV.APIFY_TOKEN }, fetchFn as never);
    const err = await provider.fetchRecentPosts("someone", 5).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toBe("apify_request_failed_429");
    expect(err.message).not.toContain("apify-secret");
  });
});

// Fake Supabase state for ingestion tests.
function fakeDb(opts: { existingPostIds?: string[]; parents?: { child_id: number; parent_id: number }[]; directAccounts?: number[] } = {}) {
  const writes: { method: string; url: string; body: unknown }[] = [];
  const existing = new Set(opts.existingPostIds ?? []);
  let nextId = 100;
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (method !== "GET") writes.push({ method, url, body });
    const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });

    if (url.includes("/rest/v1/discovery_runs") && method === "POST") return json([{ id: 7 }], 201);
    if (url.includes("/rest/v1/reference_accounts?select=username")) return json([{ username: "famous" }]);
    if (url.includes("/rest/v1/source_posts") && method === "POST") {
      const rows = (body as { provider_post_id: string }[]).filter((r) => !existing.has(r.provider_post_id));
      return json(rows.map((r) => ({ id: nextId++, provider_post_id: r.provider_post_id, ...r })), 201);
    }
    if (url.includes("/rest/v1/memes") && method === "POST") {
      return json((body as { source_post_id: number }[]).map((r) => ({ id: nextId++, source_post_id: r.source_post_id })), 201);
    }
    if (url.includes("/rest/v1/account_reference_assignments")) {
      return json((opts.directAccounts ?? []).map((account_id) => ({ account_id })));
    }
    if (url.includes("/rest/v1/account_parents")) {
      const m = /parent_id=in\.\(([\d,]+)\)/.exec(url);
      const ids = m ? m[1].split(",").map(Number) : [];
      return json((opts.parents ?? []).filter((p) => ids.includes(p.parent_id)).map((p) => ({ child_id: p.child_id })));
    }
    if (method === "POST" || method === "PATCH") return json([{}], 201);
    return json([]);
  });
  return { fetchFn, writes };
}

const provider = (posts: { providerPostId: string; permalink: string }[]): SourceProvider => ({
  fetchRecentPosts: async () => posts.map((p) => ({ ...p, postType: "photo" as const, caption: null })),
});

describe("ingestReference", () => {
  it("stores only unseen posts and skips ones already in the database", async () => {
    const { fetchFn, writes } = fakeDb({ existingPostIds: ["old"], directAccounts: [1] });
    const result = await ingestReference(ENV, 9, provider([
      { providerPostId: "old", permalink: "https://instagram.com/p/old/" },
      { providerPostId: "new", permalink: "https://instagram.com/p/new/" },
    ]), fetchFn as never);
    expect(result.newPosts).toBe(1);
    const sourcePosts = writes.find((w) => w.url.includes("/rest/v1/source_posts"))!;
    expect(sourcePosts.url).toContain("on_conflict=provider_post_id");
  });

  it("assigns new memes to direct accounts and their descendants (inheritance)", async () => {
    // Account 1 uses the source; account 2 inherits from 1; account 3 inherits from 2.
    const { fetchFn, writes } = fakeDb({
      directAccounts: [1],
      parents: [{ child_id: 2, parent_id: 1 }, { child_id: 3, parent_id: 2 }],
    });
    await ingestReference(ENV, 9, provider([{ providerPostId: "p1", permalink: "https://instagram.com/p/p1/" }]), fetchFn as never);
    const assignments = writes.find((w) => w.url.includes("/rest/v1/meme_assignments"))!.body as { account_id: number }[];
    expect(assignments.map((a) => a.account_id).sort()).toEqual([1, 2, 3]);
  });

  it("does not loop forever on a parent cycle in the data", async () => {
    const { fetchFn } = fakeDb({
      directAccounts: [1],
      parents: [{ child_id: 2, parent_id: 1 }, { child_id: 1, parent_id: 2 }],
    });
    const ids = await accountsForReference(ENV, 9, fetchFn as never);
    expect(ids.sort()).toEqual([1, 2]);
  });

  it("writes no memes or assignments when nothing is new", async () => {
    const { fetchFn, writes } = fakeDb({ existingPostIds: ["x"], directAccounts: [1] });
    const result = await ingestReference(ENV, 9, provider([{ providerPostId: "x", permalink: "https://instagram.com/p/x/" }]), fetchFn as never);
    expect(result.newPosts).toBe(0);
    expect(writes.some((w) => w.url.includes("/rest/v1/memes") || w.url.includes("meme_assignments"))).toBe(false);
  });
});

describe("reference routes are admin-only", () => {
  it("rejects anonymous discovery runs", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const res = await worker.fetch(new Request("https://w.test/api/references/1/discover", { method: "POST" }), ENV as never);
    expect(res.status).toBe(401);
    vi.unstubAllGlobals();
  });

  it("rejects anonymous reference deletes", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const res = await worker.fetch(new Request("https://w.test/api/references/1", { method: "DELETE" }), ENV as never);
    expect(res.status).toBe(401);
    vi.unstubAllGlobals();
  });
});
