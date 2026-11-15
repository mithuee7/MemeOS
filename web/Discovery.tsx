import { FormEvent, useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api";

interface Reference {
  id: number;
  username: string;
  enabled: boolean;
  discovery_interval_minutes: number;
  last_scraped_at: string | null;
  last_error: string | null;
  last_post_count: number;
}

const ERROR_TEXT: Record<string, string> = {
  apify_not_configured: "Apify isn't connected yet. Add the APIFY_TOKEN secret to the Worker to run discovery.",
  discovery_failed: "Discovery failed. See the error on this source.",
  invalid_username: "Use 1–30 letters, numbers, dots or underscores.",
  already_exists: "That source is already added.",
};

function message(err: unknown): string {
  return err instanceof ApiError ? (ERROR_TEXT[err.code] ?? "Something went wrong.") : "Something went wrong.";
}

export function DiscoveryPage() {
  const [refs, setRefs] = useState<Reference[] | null>(null);
  const [username, setUsername] = useState("");
  const [busyId, setBusyId] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ references: Reference[] }>("/api/references");
      setRefs(data.references);
    } catch (err) {
      setNotice({ kind: "error", text: message(err) });
      setRefs([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setNotice(null);
    try {
      await api("/api/references", { method: "POST", body: JSON.stringify({ username }) });
      setUsername("");
      await load();
    } catch (err) {
      setNotice({ kind: "error", text: message(err) });
    }
  }

  async function toggle(r: Reference) {
    try {
      await api(`/api/references/${r.id}`, { method: "PATCH", body: JSON.stringify({ enabled: !r.enabled }) });
      await load();
    } catch (err) {
      setNotice({ kind: "error", text: message(err) });
    }
  }

  async function runNow(r: Reference) {
    setBusyId(r.id);
    setNotice(null);
    try {
      const result = await api<{ newPosts: number }>(`/api/references/${r.id}/discover`, { method: "POST" });
      setNotice({ kind: "ok", text: `@${r.username}: ${result.newPosts} new post${result.newPosts === 1 ? "" : "s"} found.` });
      await load();
    } catch (err) {
      setNotice({ kind: "error", text: message(err) });
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function remove(r: Reference) {
    if (!window.confirm(`Remove @${r.username} from discovery? Memes already found are kept.`)) return;
    try {
      await api(`/api/references/${r.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setNotice({ kind: "error", text: message(err) });
    }
  }

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Discovery</h1>
          <p className="muted">Reference Instagram accounts MemeOS scrapes for new posts. Each source is scraped once, however many accounts use it.</p>
        </div>
      </header>

      <form className="card add-row" onSubmit={add}>
        <input aria-label="Reference username" placeholder="@reference_account" value={username} onChange={(e) => setUsername(e.target.value)} maxLength={40} required />
        <button className="primary" disabled={!username.trim()}>Add source</button>
      </form>

      {notice && <div className={`alert ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</div>}

      {refs === null && <div className="card muted">Loading sources…</div>}
      {refs && refs.length === 0 && (
        <div className="card empty">
          <h2>No reference sources yet</h2>
          <p className="muted">Add a public Instagram account whose memes you want MemeOS to find.</p>
        </div>
      )}
      {refs && refs.length > 0 && (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr><th>Source</th><th>Status</th><th>Last scrape</th><th>Posts found</th><th>Enabled</th><th></th></tr>
            </thead>
            <tbody>
              {refs.map((r) => (
                <tr key={r.id}>
                  <td>@{r.username}</td>
                  <td>{r.last_error ? <span className="bad" title={r.last_error}>Error</span> : r.last_scraped_at ? "OK" : "Not scraped yet"}</td>
                  <td className="muted">{r.last_scraped_at ? new Date(r.last_scraped_at).toLocaleString() : "—"}</td>
                  <td>{r.last_post_count}</td>
                  <td><button className="toggle" aria-pressed={r.enabled} onClick={() => toggle(r)}>{r.enabled ? "On" : "Off"}</button></td>
                  <td className="row-actions">
                    <button className="secondary" disabled={busyId === r.id || !r.enabled} onClick={() => runNow(r)}>
                      {busyId === r.id ? "Scraping…" : "Run now"}
                    </button>
                    <button className="link danger" onClick={() => remove(r)}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
