import { useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api";

type Notice = { kind: "ok" | "error"; text: string } | null;
interface Account { id: number; handle: string }

interface Slot {
  id: number;
  scheduled_for: string;
  status: string;
  last_error: string | null;
  account: { handle: string } | null;
  assignment: { id: number; media_type: string; meme: { extracted_text: string | null; edited_text: string | null } | null } | null;
}

interface ApprovedItem {
  id: number;
  media_type: string;
  meme: { extracted_text: string | null; edited_text: string | null } | null;
}

function errorText(err: unknown): string {
  if (!(err instanceof ApiError)) return "Something went wrong. Try again.";
  const map: Record<string, string> = {
    not_approved: "Only approved memes can be scheduled. Approve it in the Approval Queue first.",
    already_scheduled: "This meme is already scheduled.",
    time_in_past: "Pick a time in the future.",
    not_movable: "This post has already started and can't be moved.",
    not_cancellable: "Only scheduled posts can be cancelled.",
    invalid_times: "Use times like 09:00, up to 10 per day.",
    invalid_timezone: "That timezone isn't recognised. Use a name like Asia/Kolkata.",
  };
  return map[err.code] ?? "Something went wrong. Try again.";
}

// Converts a Date to the value a datetime-local input expects, in the browser's timezone.
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SchedulerPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState<string>("");
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [approved, setApproved] = useState<ApprovedItem[]>([]);
  const [times, setTimes] = useState("09:00, 13:00, 18:30");
  const [timezone, setTimezone] = useState("Asia/Kolkata");
  const [editing, setEditing] = useState<{ id: number; value: string } | null>(null);
  const [schedAt, setSchedAt] = useState<Record<number, string>>({});
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    api<{ accounts: Account[] }>("/api/accounts")
      .then((d) => {
        setAccounts(d.accounts);
        if (d.accounts[0]) setAccountId(String(d.accounts[0].id));
      })
      .catch(() => setNotice({ kind: "error", text: "Couldn't load accounts." }));
  }, []);

  const load = useCallback(async () => {
    if (!accountId) return;
    try {
      const from = new Date().toISOString();
      const to = new Date(Date.now() + 14 * 86_400_000).toISOString();
      const [sched, appr, settings] = await Promise.all([
        api<{ items: Slot[] }>(`/api/schedule?account_id=${accountId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
        api<{ items: ApprovedItem[] }>(`/api/approvals?status=approved&account_id=${accountId}&limit=100`),
        api<{ settings: { post_times: string[]; timezone: string } }>(`/api/accounts/${accountId}/settings`),
      ]);
      setSlots(sched.items);
      setApproved(appr.items);
      setTimes(settings.settings.post_times.join(", "));
      setTimezone(settings.settings.timezone);
    } catch (err) {
      setNotice({ kind: "error", text: errorText(err) });
      setSlots([]);
    }
  }, [accountId]);

  useEffect(() => { load(); }, [load]);

  async function saveTimes() {
    const list = times.split(",").map((t) => t.trim()).filter(Boolean);
    try {
      await api(`/api/accounts/${accountId}/settings`, { method: "PUT", body: JSON.stringify({ post_times: list, timezone }) });
      setNotice({ kind: "ok", text: "Daily times saved." });
      await load();
    } catch (err) {
      setNotice({ kind: "error", text: errorText(err) });
    }
  }

  async function fill() {
    try {
      const r = await api<{ scheduled: number }>("/api/schedule/auto", { method: "POST", body: JSON.stringify({ account_id: Number(accountId) }) });
      setNotice({ kind: "ok", text: r.scheduled ? `${r.scheduled} approved meme(s) scheduled into free slots.` : "No approved memes are waiting to be scheduled." });
      await load();
    } catch (err) {
      setNotice({ kind: "error", text: errorText(err) });
    }
  }

  async function scheduleOne(assignmentId: number) {
    const when = schedAt[assignmentId];
    if (!when) return setNotice({ kind: "error", text: "Pick a date and time first." });
    try {
      await api("/api/schedule", { method: "POST", body: JSON.stringify({ assignment_id: assignmentId, scheduled_for: new Date(when).toISOString() }) });
      setNotice({ kind: "ok", text: "Scheduled." });
      await load();
    } catch (err) {
      setNotice({ kind: "error", text: errorText(err) });
    }
  }

  async function saveMove() {
    if (!editing) return;
    try {
      await api(`/api/schedule/${editing.id}`, { method: "PATCH", body: JSON.stringify({ scheduled_for: new Date(editing.value).toISOString() }) });
      setEditing(null);
      await load();
    } catch (err) {
      setNotice({ kind: "error", text: errorText(err) });
    }
  }

  async function cancel(id: number) {
    if (!window.confirm("Cancel this scheduled post? The meme stays approved.")) return;
    try {
      await api(`/api/schedule/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setNotice({ kind: "error", text: errorText(err) });
    }
  }

  // Group slots by local day for a calendar-style list.
  const groups = new Map<string, Slot[]>();
  for (const s of slots ?? []) {
    const day = new Date(s.scheduled_for).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    groups.set(day, [...(groups.get(day) ?? []), s]);
  }

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Scheduler</h1>
          <p className="muted">Approved memes are published at each account's daily times. Times below are shown in your browser's timezone.</p>
        </div>
        <select aria-label="Account" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.map((a) => <option key={a.id} value={a.id}>@{a.handle}</option>)}
        </select>
      </header>

      {notice && <div className={`alert ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</div>}

      {accounts.length === 0 && (
        <div className="card empty"><h2>No accounts yet</h2><p className="muted">Add an account in Accounts first.</p></div>
      )}

      {accounts.length > 0 && (
        <>
          <div className="card stack-row">
            <div>
              <h2>Daily times</h2>
              <p className="muted small">Comma-separated, 24-hour, in the account's timezone.</p>
            </div>
            <input aria-label="Post times" value={times} onChange={(e) => setTimes(e.target.value)} />
            <input aria-label="Timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
            <button className="secondary" onClick={saveTimes}>Save times</button>
            <button className="primary" onClick={fill} disabled={approved.length === 0}>Fill free slots</button>
          </div>

          <h2 className="section-title">Ready to schedule</h2>
          {approved.length === 0 && <div className="card muted">No approved memes waiting. Approve memes in the Approval Queue.</div>}
          {approved.length > 0 && (
            <div className="card table-wrap">
              <table>
                <thead><tr><th>Meme</th><th>Format</th><th>Schedule at</th><th></th></tr></thead>
                <tbody>
                  {approved.map((a) => (
                    <tr key={a.id}>
                      <td className="text-cell">{a.meme?.edited_text ?? a.meme?.extracted_text ?? <span className="muted">No text yet</span>}</td>
                      <td>{a.media_type}</td>
                      <td>
                        <input type="datetime-local" aria-label={`Schedule time for item ${a.id}`} value={schedAt[a.id] ?? ""} min={toLocalInput(new Date())} onChange={(e) => setSchedAt({ ...schedAt, [a.id]: e.target.value })} />
                      </td>
                      <td><button className="secondary" onClick={() => scheduleOne(a.id)}>Schedule</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h2 className="section-title">Next 14 days</h2>
          {slots === null && <div className="card muted">Loading schedule…</div>}
          {slots && slots.length === 0 && <div className="card empty"><h2>Nothing scheduled</h2><p className="muted">Use Fill free slots, or schedule a specific time above.</p></div>}
          {[...groups.entries()].map(([day, items]) => (
            <div key={day} className="day-group">
              <h3 className="day-title">{day}</h3>
              {items.map((s) => (
                <div key={s.id} className="card slot">
                  <div className="slot-time">{new Date(s.scheduled_for).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</div>
                  <div className="slot-body">
                    <div className="muted small">@{s.account?.handle} · {s.assignment?.media_type}</div>
                    <div className="text-cell">{s.assignment?.meme?.edited_text ?? s.assignment?.meme?.extracted_text ?? "No text yet"}</div>
                    {s.last_error && <div className="small danger">{s.last_error}</div>}
                  </div>
                  <div className="slot-actions">
                    <span className={`pill ${s.status}`}>{s.status}</span>
                    {s.status === "scheduled" && (
                      editing?.id === s.id ? (
                        <>
                          <input type="datetime-local" aria-label="New time" value={editing.value} onChange={(e) => setEditing({ id: s.id, value: e.target.value })} />
                          <button className="primary" onClick={saveMove}>Save</button>
                          <button className="link" onClick={() => setEditing(null)}>Cancel</button>
                        </>
                      ) : (
                        <>
                          <button className="link" onClick={() => setEditing({ id: s.id, value: toLocalInput(new Date(s.scheduled_for)) })}>Move</button>
                          <button className="link danger" onClick={() => cancel(s.id)}>Cancel post</button>
                        </>
                      )
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </>
      )}
    </section>
  );
}
