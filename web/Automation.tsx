import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api";

interface Job { id: number; kind: string; status: string; attempts: number; last_error: string | null; next_run_at: string; updated_at: string }
interface Status { paused: boolean; jobs: Job[] }
type Notice = { kind: "ok" | "error"; text: string } | null;

function errorText(err: unknown): string {
  if (err instanceof ApiError && err.status === 403) return "Only administrators can change automation.";
  return "Something went wrong. Try again.";
}

// Global pause. Lives in Settings; it stops discovery, processing and publishing, and keeps all state.
export function PauseControl() {
  const [paused, setPaused] = useState<boolean | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<Status>("/api/automation").then((d) => setPaused(d.paused)).catch(() => setPaused(null));
  }, []);

  async function toggle() {
    if (paused === null) return;
    const next = !paused;
    if (!window.confirm(next ? "Pause all automation? Queued memes and schedules are kept." : "Resume automation?")) return;
    setBusy(true);
    try {
      await api("/api/automation/pause", { method: "PUT", body: JSON.stringify({ paused: next }) });
      setPaused(next);
      setNotice({ kind: "ok", text: next ? "Automation paused." : "Automation resumed." });
    } catch (err) {
      setNotice({ kind: "error", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack-row">
      <div>
        <h2>Global pause</h2>
        <p className="muted small">Stops discovery, processing and scheduled publishing. Queued memes, schedules and job history are kept.</p>
      </div>
      <span className={`pill ${paused ? "failed" : "ok"}`}>{paused === null ? "Unknown" : paused ? "Paused" : "Running"}</span>
      <button className={paused ? "primary" : "secondary"} disabled={paused === null || busy} onClick={toggle}>
        {paused ? "Resume automation" : "Pause automation"}
      </button>
      {notice && <div className={`alert ${notice.kind}`} role="status">{notice.text}</div>}
    </div>
  );
}

export function AutomationPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await api<Status>("/api/automation"));
    } catch (err) {
      setNotice({ kind: "error", text: errorText(err) });
      setStatus({ paused: false, jobs: [] });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function runNow() {
    setBusy(true);
    setNotice(null);
    try {
      const r = await api<{ paused: boolean; ran: number; succeeded: number; failed: number; enqueued: number }>("/api/automation/tick", { method: "POST" });
      setNotice({
        kind: "ok",
        text: r.paused ? "Automation is paused, so nothing ran." : `Queued ${r.enqueued}, ran ${r.ran} (${r.succeeded} succeeded, ${r.failed} failed).`,
      });
      await load();
    } catch (err) {
      setNotice({ kind: "error", text: errorText(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Automation</h1>
          <p className="muted">Background jobs: discovery runs, retries and recovery. Failed jobs retry with backoff; configuration errors don't.</p>
        </div>
        <button className="primary" onClick={runNow} disabled={busy || status?.paused}>{busy ? "Running…" : "Run due jobs now"}</button>
      </header>

      {notice && <div className={`alert ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</div>}
      {status?.paused && <div className="alert error" role="status">Automation is paused in Settings, so jobs won't run.</div>}

      {status === null && <div className="card muted">Loading jobs…</div>}
      {status && status.jobs.length === 0 && (
        <div className="card empty"><h2>No jobs yet</h2><p className="muted">Jobs appear once a source is due for discovery, or after you run discovery.</p></div>
      )}
      {status && status.jobs.length > 0 && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th>Job</th><th>Status</th><th>Attempts</th><th>Next run</th><th>Last error</th></tr></thead>
            <tbody>
              {status.jobs.map((j) => (
                <tr key={j.id}>
                  <td>{j.kind}</td>
                  <td><span className={`pill ${j.status}`}>{j.status}</span></td>
                  <td>{j.attempts}</td>
                  <td className="muted">{new Date(j.next_run_at).toLocaleString()}</td>
                  <td className="muted small">{j.last_error ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
