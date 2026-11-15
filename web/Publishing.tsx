import { useEffect, useState } from "react";
import { ApiError, api } from "./api";

interface Item {
  id: number;
  status: string;
  attempts: number;
  permalink: string | null;
  error: string | null;
  published_at: string | null;
  created_at: string;
  assignment: { account: { handle: string } | null; meme: { edited_text: string | null; extracted_text: string | null } | null } | null;
}

const FILTERS = ["all", "published", "failed", "publishing", "pending"] as const;

export function PublishingHistoryPage() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setItems(null);
    setError(null);
    const q = filter === "all" ? "" : `?status=${filter}`;
    api<{ items: Item[] }>(`/api/publish-history${q}`)
      .then((d) => setItems(d.items))
      .catch((err) => {
        setError(err instanceof ApiError && err.status === 403 ? "Only administrators can view publishing history." : "Couldn't load publishing history.");
        setItems([]);
      });
  }, [filter]);

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Publishing History</h1>
          <p className="muted">Every publish attempt, with its result. Failed attempts show the reason and are not retried silently.</p>
        </div>
        <div className="seg">
          {FILTERS.map((f) => (
            <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{f}</button>
          ))}
        </div>
      </header>

      {error && <div className="alert error" role="alert">{error}</div>}
      {items === null && <div className="card muted">Loading history…</div>}
      {items && items.length === 0 && !error && (
        <div className="card empty">
          <h2>Nothing published yet</h2>
          <p className="muted">Posts appear here once scheduled items are published through a connected Meta account.</p>
        </div>
      )}
      {items && items.length > 0 && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Meme</th><th>Account</th><th>Status</th><th>Attempts</th><th>When</th><th>Link</th></tr></thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td className="text-cell">{i.assignment?.meme?.edited_text ?? i.assignment?.meme?.extracted_text ?? <span className="muted">No text</span>}</td>
                  <td>@{i.assignment?.account?.handle ?? "—"}</td>
                  <td>
                    <span className={`pill ${i.status === "published" ? "ok" : i.status === "failed" ? "failed" : ""}`}>{i.status}</span>
                    {i.error && <div className="small danger">{i.error}</div>}
                  </td>
                  <td>{i.attempts}</td>
                  <td className="muted">{new Date(i.published_at ?? i.created_at).toLocaleString()}</td>
                  <td>{i.permalink ? <a href={i.permalink} target="_blank" rel="noreferrer">Open</a> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
