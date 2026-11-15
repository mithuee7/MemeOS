import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api";

type Notice = { kind: "ok" | "error"; text: string } | null;

function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return "Only administrators can do this.";
    if (err.status === 401) return "Your session expired. Sign in again.";
    if (err.code === "invalid_ids") return "Select up to 200 items.";
  }
  return "Something went wrong. Try again.";
}

function Pager({ page, total, limit, onPage }: { page: number; total: number; limit: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="pager">
      <span className="muted small">{total} total · page {page} of {pages}</span>
      <div className="row-actions">
        <button className="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
        <button className="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button>
      </div>
    </div>
  );
}

// ---------- Approval queue ----------------------------------------------------

interface ApprovalItem {
  id: number;
  account_id: number;
  approval_status: "pending" | "approved" | "rejected";
  media_type: string;
  audio_status: string;
  account: { handle: string } | null;
  meme: {
    id: number;
    status: string;
    extracted_text: string | null;
    edited_text: string | null;
    source: { permalink: string; caption: string | null; post_type: string; reference: { username: string } | null } | null;
  } | null;
}

interface Account { id: number; handle: string }

export function ApprovalQueue() {
  const [items, setItems] = useState<ApprovalItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<"pending" | "approved" | "rejected">("pending");
  const [accountId, setAccountId] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<{ memeId: number; text: string } | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const limit = 50;

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ status, page: String(page), limit: String(limit) });
      if (accountId) qs.set("account_id", accountId);
      const data = await api<{ items: ApprovalItem[]; total: number }>(`/api/approvals?${qs}`);
      setItems(data.items);
      setTotal(data.total);
      setSelected(new Set());
    } catch (err) {
      setNotice({ kind: "error", text: errorText(err) });
      setItems([]);
    }
  }, [status, accountId, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api<{ accounts: Account[] }>("/api/accounts").then((d) => setAccounts(d.accounts)).catch(() => setAccounts([]));
  }, []);

  async function setOne(id: number, next: "approved" | "rejected" | "pending") {
    try {
      await api(`/api/approvals/${id}`, { method: "PATCH", body: JSON.stringify({ approval_status: next }) });
      await load();
    } catch (err) {
      setNotice({ kind: "error", text: errorText(err) });
    }
  }

  async function bulk(next: "approved" | "rejected") {
    if (selected.size === 0) return;
    if (!window.confirm(`${next === "approved" ? "Approve" : "Reject"} ${selected.size} selected item(s)? Each applies only to its own account.`)) return;
    try {
      await api("/api/approvals/bulk", { method: "POST", body: JSON.stringify({ ids: [...selected], approval_status: next }) });
      setNotice({ kind: "ok", text: `${selected.size} item(s) updated.` });
      await load();
    } catch (err) {
      setNotice({ kind: "error", text: errorText(err) });
    }
  }

  async function saveText() {
    if (!editing) return;
    try {
      await api(`/api/memes/${editing.memeId}`, { method: "PATCH", body: JSON.stringify({ edited_text: editing.text }) });
      setEditing(null);
      setNotice({ kind: "ok", text: "Text saved. It applies to this meme on every account." });
      await load();
    } catch (err) {
      setNotice({ kind: "error", text: errorText(err) });
    }
  }

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Approval Queue</h1>
          <p className="muted">Each row is one meme for one account. Approving here never approves it for another account.</p>
        </div>
      </header>

      <div className="toolbar">
        <div className="seg">
          {(["pending", "approved", "rejected"] as const).map((s) => (
            <button key={s} className={status === s ? "on" : ""} onClick={() => { setStatus(s); setPage(1); }}>{s}</button>
          ))}
        </div>
        <select aria-label="Account" value={accountId} onChange={(e) => { setAccountId(e.target.value); setPage(1); }}>
          <option value="">All accounts</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>@{a.handle}</option>)}
        </select>
      </div>

      {notice && <div className={`alert ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</div>}

      {selected.size > 0 && (
        <div className="bulkbar">
          <span>{selected.size} selected</span>
          <button className="primary" onClick={() => bulk("approved")}>Approve selected</button>
          <button className="secondary" onClick={() => bulk("rejected")}>Reject selected</button>
          <button className="link" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {items === null && <div className="card muted">Loading queue…</div>}
      {items && items.length === 0 && (
        <div className="card empty">
          <h2>Nothing {status} right now</h2>
          <p className="muted">Memes appear here after a Discovery run finds new posts from a source assigned to an account.</p>
        </div>
      )}

      {items && items.map((it) => (
        <article key={it.id} className="card queue-item">
          <label className="check">
            <input type="checkbox" checked={selected.has(it.id)} onChange={() => toggle(it.id)} aria-label={`Select item ${it.id}`} />
          </label>
          <div className="queue-body">
            <div className="queue-meta">
              <span>@{it.account?.handle ?? "unknown"}</span>
              <span className="muted">from @{it.meme?.source?.reference?.username ?? "unknown"}</span>
              <span className="pill">{it.media_type}</span>
              <span className={`pill ${it.approval_status}`}>{it.approval_status}</span>
            </div>
            <p className="meme-text">
              {it.meme?.edited_text ?? it.meme?.extracted_text ?? <span className="muted">No text extracted yet. OCR runs in the processing stage.</span>}
            </p>
            {it.meme?.source?.caption && <p className="muted small caption">Caption: {it.meme.source.caption}</p>}
            {it.meme?.source?.permalink && (
              <a className="small" href={it.meme.source.permalink} target="_blank" rel="noreferrer">Open original post</a>
            )}
          </div>
          <div className="queue-actions">
            {it.approval_status !== "approved" && <button className="primary" onClick={() => setOne(it.id, "approved")}>Approve</button>}
            {it.approval_status !== "rejected" && <button className="secondary" onClick={() => setOne(it.id, "rejected")}>Reject</button>}
            {it.approval_status !== "pending" && <button className="link" onClick={() => setOne(it.id, "pending")}>Reset to pending</button>}
            {it.meme && (
              <button className="link" onClick={() => setEditing({ memeId: it.meme!.id, text: it.meme!.edited_text ?? it.meme!.extracted_text ?? "" })}>Edit text</button>
            )}
          </div>
        </article>
      ))}

      {items && total > 0 && <Pager page={page} total={total} limit={limit} onPage={setPage} />}

      {editing && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal card">
            <h2>Edit meme text</h2>
            <p className="muted small">This changes the meme everywhere it appears. The original post is never changed.</p>
            <textarea value={editing.text} maxLength={2000} rows={6} onChange={(e) => setEditing({ ...editing, text: e.target.value })} />
            <div className="row-actions">
              <button className="link" onClick={() => setEditing(null)}>Cancel</button>
              <button className="primary" onClick={saveText}>Save text</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------- Content library ----------------------------------------------------

interface LibraryItem {
  id: number;
  origin: string;
  status: string;
  failure_reason: string | null;
  extracted_text: string | null;
  edited_text: string | null;
  created_at: string;
  source: { permalink: string; post_type: string; reference: { username: string } | null } | null;
  assignments: { approval_status: string; account: { handle: string } | null }[];
}

export function ContentLibrary() {
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const limit = 50;

  const load = useCallback(async () => {
    try {
      const data = await api<{ items: LibraryItem[]; total: number }>(`/api/library?page=${page}&limit=${limit}`);
      setItems(data.items);
      setTotal(data.total);
    } catch (err) {
      setNotice({ kind: "error", text: errorText(err) });
      setItems([]);
    }
  }, [page]);

  useEffect(() => { load(); }, [load]);

  // Search applies to the rows on this page. A server-side full-text index is a later step.
  const shown = (items ?? []).filter((m) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const text = `${m.edited_text ?? ""} ${m.extracted_text ?? ""} ${m.source?.reference?.username ?? ""}`.toLowerCase();
    return text.includes(q);
  });

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Content Library</h1>
          <p className="muted">Every meme MemeOS has found or created, with its source, status and where it's assigned.</p>
        </div>
      </header>

      <div className="toolbar">
        <input aria-label="Search library" placeholder="Search this page by text or source" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {notice && <div className={`alert ${notice.kind}`} role="alert">{notice.text}</div>}

      {items === null && <div className="card muted">Loading library…</div>}
      {items && items.length === 0 && (
        <div className="card empty">
          <h2>The library is empty</h2>
          <p className="muted">Run Discovery on a source. Found posts show up here.</p>
        </div>
      )}
      {items && items.length > 0 && (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr><th>Source</th><th>Text</th><th>Status</th><th>Assigned to</th><th>Found</th></tr>
            </thead>
            <tbody>
              {shown.map((m) => (
                <tr key={m.id}>
                  <td>
                    {m.source?.reference ? `@${m.source.reference.username}` : "—"}
                    {m.source?.permalink && <> · <a className="small" href={m.source.permalink} target="_blank" rel="noreferrer">post</a></>}
                  </td>
                  <td className="text-cell">{m.edited_text ?? m.extracted_text ?? <span className="muted">Not extracted yet</span>}</td>
                  <td>
                    <span className="pill">{m.status.replace(/_/g, " ")}</span>
                    {m.failure_reason && <div className="muted small">{m.failure_reason}</div>}
                  </td>
                  <td className="muted small">
                    {m.assignments.length === 0 ? "—" : m.assignments.map((a) => `@${a.account?.handle} (${a.approval_status})`).join(", ")}
                  </td>
                  <td className="muted">{new Date(m.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {items && total > 0 && <Pager page={page} total={total} limit={limit} onPage={setPage} />}
    </section>
  );
}

// ---------- System health ------------------------------------------------------

interface Health {
  database: { ok: boolean };
  paused: boolean;
  integrations: { provider: string; status: string; status_detail: string | null; last4: string; tested_at: string | null }[];
  discovery_runs: { id: number; status: string; new_posts: number; error: string | null; started_at: string; reference: { username: string } | null }[];
  logs: { id: number; severity: string; workflow: string; message: string; created_at: string }[];
  failed_jobs: { id: number; kind: string; status: string; attempts: number; last_error: string | null; updated_at: string }[];
}

export function SystemHealth() {
  const [data, setData] = useState<Health | null>(null);
  const [severity, setSeverity] = useState("");
  const [notice, setNotice] = useState<Notice>(null);

  const load = useCallback(async () => {
    try {
      setData(await api<Health>(`/api/system-health${severity ? `?severity=${severity}` : ""}`));
      setNotice(null);
    } catch (err) {
      setNotice({ kind: "error", text: errorText(err) });
    }
  }, [severity]);

  useEffect(() => { load(); }, [load]);

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>System Health</h1>
          <p className="muted">Connection status, discovery runs, failed jobs and logs. Secrets are never shown.</p>
        </div>
        <button className="secondary" onClick={load}>Refresh</button>
      </header>

      {notice && <div className={`alert ${notice.kind}`} role="alert">{notice.text}</div>}
      {!data && !notice && <div className="card muted">Loading status…</div>}

      {data && (
        <>
          <div className="stat-grid">
            <div className="stat"><div className="muted small">Database</div><div className="stat-value">{data.database.ok ? "Connected" : "Down"}</div></div>
            <div className="stat"><div className="muted small">Automation</div><div className="stat-value">{data.paused ? "Paused" : "Running"}</div></div>
            <div className="stat"><div className="muted small">Failed jobs</div><div className="stat-value">{data.failed_jobs.length}</div></div>
          </div>

          <h2 className="section-title">Connections</h2>
          <div className="card table-wrap">
            <table>
              <thead><tr><th>Provider</th><th>Status</th><th>Key</th><th>Last test</th></tr></thead>
              <tbody>
                {data.integrations.length === 0 && <tr><td colSpan={4} className="muted">No connections saved yet. Add them in Settings → Connections.</td></tr>}
                {data.integrations.map((i) => (
                  <tr key={i.provider}>
                    <td>{i.provider}</td>
                    <td><span className={`pill ${i.status}`}>{i.status}</span> <span className="muted small">{i.status_detail}</span></td>
                    <td className="muted">····{i.last4}</td>
                    <td className="muted">{i.tested_at ? new Date(i.tested_at).toLocaleString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className="section-title">Discovery runs</h2>
          <div className="card table-wrap">
            <table>
              <thead><tr><th>Source</th><th>Status</th><th>New posts</th><th>Started</th><th>Error</th></tr></thead>
              <tbody>
                {data.discovery_runs.length === 0 && <tr><td colSpan={5} className="muted">No discovery runs yet.</td></tr>}
                {data.discovery_runs.map((r) => (
                  <tr key={r.id}>
                    <td>{r.reference ? `@${r.reference.username}` : "—"}</td>
                    <td><span className={`pill ${r.status}`}>{r.status}</span></td>
                    <td>{r.new_posts}</td>
                    <td className="muted">{new Date(r.started_at).toLocaleString()}</td>
                    <td className="muted small">{r.error ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h2 className="section-title">Failed or paused jobs</h2>
          <div className="card table-wrap">
            <table>
              <thead><tr><th>Job</th><th>Status</th><th>Attempts</th><th>Last error</th></tr></thead>
              <tbody>
                {data.failed_jobs.length === 0 && <tr><td colSpan={4} className="muted">No failed jobs.</td></tr>}
                {data.failed_jobs.map((j) => (
                  <tr key={j.id}><td>{j.kind}</td><td>{j.status}</td><td>{j.attempts}</td><td className="muted small">{j.last_error ?? "—"}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="section-head">
            <h2 className="section-title">Logs</h2>
            <select aria-label="Severity" value={severity} onChange={(e) => setSeverity(e.target.value)}>
              <option value="">All severities</option>
              <option value="error">Errors</option>
              <option value="warning">Warnings</option>
              <option value="info">Info</option>
            </select>
          </div>
          <div className="card table-wrap">
            <table>
              <thead><tr><th>Time</th><th>Severity</th><th>Workflow</th><th>Message</th></tr></thead>
              <tbody>
                {data.logs.length === 0 && <tr><td colSpan={4} className="muted">No log entries.</td></tr>}
                {data.logs.map((l) => (
                  <tr key={l.id}>
                    <td className="muted small">{new Date(l.created_at).toLocaleString()}</td>
                    <td><span className={`pill ${l.severity}`}>{l.severity}</span></td>
                    <td>{l.workflow}</td>
                    <td className="small">{l.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
