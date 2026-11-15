import { SupabaseEnv, insertIgnoreDuplicates, patch, select, insert } from "./supabase";

// ---------- Provider abstraction ----------------------------------------------
// The scraper can be replaced by implementing SourceProvider. Nothing else in the
// discovery pipeline depends on Apify directly.

export interface SourcePost {
  providerPostId: string;
  permalink: string;
  postType: "photo" | "reel" | "carousel" | "other" | "unknown";
  caption: string | null;
}

export interface SourceProvider {
  fetchRecentPosts(handle: string, limit: number): Promise<SourcePost[]>;
}

export interface ApifyEnv extends SupabaseEnv {
  APIFY_TOKEN?: string;
  APIFY_ACTOR_ID: string; // e.g. "scraply~instagram-api-scraper"
}

type FetchFn = typeof fetch;

// Maps one raw Apify dataset item to a SourcePost. Returns null for items that
// lack a stable id or permalink, so they can't be deduplicated safely.
// Apify's Instagram output reports type "Image", "Video" or "Sidecar".
export function mapApifyItem(item: Record<string, unknown>): SourcePost | null {
  const id = item.id ?? item.shortCode;
  const url = item.url;
  if ((typeof id !== "string" && typeof id !== "number") || typeof url !== "string") return null;
  if (!/^https:\/\/(www\.)?instagram\.com\//.test(url)) return null;

  const type = typeof item.type === "string" ? item.type : "";
  const postType: SourcePost["postType"] =
    type === "Image" ? "photo" :
    type === "Video" ? "other" :
    type === "Sidecar" ? "carousel" :
    "unknown";

  return {
    providerPostId: String(id),
    permalink: url,
    postType,
    caption: typeof item.caption === "string" ? item.caption : null,
  };
}

export class ApifyProvider implements SourceProvider {
  constructor(
    private env: ApifyEnv,
    private fetchFn: FetchFn = fetch,
  ) {}

  async fetchRecentPosts(handle: string, limit: number): Promise<SourcePost[]> {
    if (!this.env.APIFY_TOKEN) throw new ProviderNotConfigured("apify");
    const res = await this.fetchFn(
      `https://api.apify.com/v2/acts/${this.env.APIFY_ACTOR_ID}/run-sync-get-dataset-items?token=${encodeURIComponent(this.env.APIFY_TOKEN)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          directUrls: [`https://www.instagram.com/${handle}/`],
          resultsType: "posts",
          resultsLimit: limit,
        }),
      },
    );
    if (!res.ok) throw new ProviderError("apify", res.status);
    const items = (await res.json()) as Record<string, unknown>[];
    return items.map(mapApifyItem).filter((p): p is SourcePost => p !== null);
  }
}

export class ProviderNotConfigured extends Error {
  constructor(readonly provider: string) {
    super(`${provider}_not_configured`);
  }
}

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
  ) {
    // Status only: never include the request URL, which carries the token.
    super(`${provider}_request_failed_${status}`);
  }
}

// ---------- Ingestion ----------------------------------------------------------

// Scrapes one reference source once, stores new posts, and creates a meme and
// account assignments for each new post. Existing posts are skipped, so repeated
// runs never duplicate content.
export async function ingestReference(
  env: ApifyEnv & { SUPABASE_SERVICE_ROLE_KEY: string },
  referenceId: number,
  provider: SourceProvider,
  fetchFn: FetchFn = fetch,
): Promise<{ runId: number; newPosts: number }> {
  const [run] = (await insert(env, "discovery_runs", { reference_id: referenceId, status: "running" }, fetchFn)) as { id: number }[];

  try {
    const [ref] = await select<{ username: string }>(env, "reference_accounts", `select=username&id=eq.${referenceId}`, fetchFn);
    if (!ref) throw new Error("reference_not_found");

    const posts = await provider.fetchRecentPosts(ref.username, 30);

    // 1) Store unseen source posts (global dedup on provider_post_id and permalink).
    const inserted = (await insertIgnoreDuplicates(
      env,
      "source_posts",
      posts.map((p) => ({
        reference_id: referenceId,
        provider_post_id: p.providerPostId,
        permalink: p.permalink,
        post_type: p.postType,
        caption: p.caption,
      })),
      "provider_post_id",
      fetchFn,
    )) as { id: number }[];

    // 2) For each new source post, create a meme in the central library.
    const memes = (await insertIgnoreDuplicates(
      env,
      "memes",
      inserted.map((sp) => ({ source_post_id: sp.id, origin: "discovered", status: "discovered" })),
      "id",
      fetchFn,
    )) as { id: number; source_post_id: number }[];

    // 3) Assign each new meme to every account that uses this source, plus
    //    every descendant account that inherits from them.
    const targets = await accountsForReference(env, referenceId, fetchFn);
    const assignments = memes.flatMap((m) =>
      targets.map((accountId) => ({ meme_id: m.id, account_id: accountId, approval_status: "pending" })),
    );
    await insertIgnoreDuplicates(env, "meme_assignments", assignments, "meme_id,account_id", fetchFn);

    await patch(env, "discovery_runs", `id=eq.${run.id}`, {
      status: "succeeded",
      new_posts: memes.length,
      finished_at: new Date().toISOString(),
    }, fetchFn);
    await patch(env, "reference_accounts", `id=eq.${referenceId}`, {
      last_scraped_at: new Date().toISOString(),
      last_error: null,
      last_post_count: posts.length,
    }, fetchFn);

    return { runId: run.id, newPosts: memes.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown_error";
    await patch(env, "discovery_runs", `id=eq.${run.id}`, {
      status: "failed",
      error: message,
      finished_at: new Date().toISOString(),
    }, fetchFn);
    await patch(env, "reference_accounts", `id=eq.${referenceId}`, { last_error: message }, fetchFn);
    throw err;
  }
}

// Accounts that directly use the reference, plus their descendants through parent links.
export async function accountsForReference(
  env: SupabaseEnv,
  referenceId: number,
  fetchFn: FetchFn = fetch,
): Promise<number[]> {
  const direct = await select<{ account_id: number }>(
    env,
    "account_reference_assignments",
    `select=account_id&reference_id=eq.${referenceId}&enabled=eq.true`,
    fetchFn,
  );
  const seen = new Set<number>(direct.map((r) => r.account_id));
  let frontier = [...seen];
  while (frontier.length > 0) {
    const children = await select<{ child_id: number }>(
      env,
      "account_parents",
      `select=child_id&parent_id=in.(${frontier.join(",")})`,
      fetchFn,
    );
    frontier = children.map((c) => c.child_id).filter((id) => !seen.has(id));
    frontier.forEach((id) => seen.add(id));
  }
  return [...seen];
}
