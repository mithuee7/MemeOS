import { FormEvent, useCallback, useEffect, useState } from "react";
import { Session } from "./auth";
import { ApiError, api } from "./api";
import { SettingsPage } from "./Settings";
import { DiscoveryPage } from "./Discovery";

interface Account {
  id: number;
  handle: string;
  discovery_enabled: boolean;
  posts_per_day: number;
  audio_fallback: string;
  created_at: string;
}

type Page = "overview" | "accounts" | "discovery" | "settings";

export function Dashboard({ session, onSignOut }: { session: Session; onSignOut: () => void }) {
  const [page, setPage] = useState<Page>("accounts");
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api<{ accounts: Account[] }>("/api/accounts");
      setAccounts(data.accounts);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setError("Your account is signed in, but it isn't an admin yet. Ask the owner to grant access.");
      } else if (err instanceof ApiError && err.status === 401) {
        onSignOut();
      } else {
        setError("Couldn't load accounts. Check your connection and try again.");
      }
      setAccounts([]);
    }
  }, [onSignOut]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" />
          MemeOS
        </div>
        <nav>
          <NavItem label="Overview" active={page === "overview"} onClick={() => setPage("overview")} />
          <NavItem label="Accounts" active={page === "accounts"} onClick={() => setPage("accounts")} />
          <NavItem label="Discovery" active={page === "discovery"} onClick={() => setPage("discovery")} />
          <NavItem label="Approval Queue" disabled />
          <NavItem label="Content Library" disabled />
          <NavItem label="Meme Creator" disabled />
          <NavItem label="Scheduler" disabled />
          <NavItem label="Publishing History" disabled />
          <NavItem label="Analytics" disabled />
          <NavItem label="Automation" disabled />
          <NavItem label="System Health" disabled />
          <NavItem label="Settings" active={page === "settings"} onClick={() => setPage("settings")} />
        </nav>
        <div className="sidebar-foot">
          <div className="muted small">{session.email}</div>
          <button className="link" onClick={onSignOut}>Sign out</button>
        </div>
      </aside>

      <main className="main">
        {page === "overview" && <Overview accounts={accounts} />}
        {page === "accounts" && <AccountsPage accounts={accounts} error={error} onChanged={load} />}
        {page === "settings" && <SettingsPage session={session} />}
        {page === "discovery" && <DiscoveryPage />}
      </main>
    </div>
  );
}

function NavItem({ label, active, disabled, onClick }: { label: string; active?: boolean; disabled?: boolean; onClick?: () => void }) {
  return (
    <button className={`nav-item ${active ? "active" : ""}`} disabled={disabled} onClick={onClick} title={disabled ? "Coming in a later build stage" : undefined}>
      {label}
      {disabled && <span className="soon">Soon</span>}
    </button>
  );
}

function Overview({ accounts }: { accounts: Account[] | null }) {
  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="muted">Real counts from your workspace. Metrics appear once discovery and publishing are connected.</p>
        </div>
      </header>
      <div className="stat-grid">
        <Stat label="Connected accounts" value={accounts ? String(accounts.length) : "—"} />
        <Stat label="Discovered memes" value="0" hint="Discovery is not connected yet" />
        <Stat label="Pending approvals" value="0" hint="Approval queue is not built yet" />
        <Stat label="Published posts" value="0" hint="Meta publishing is not connected yet" />
      </div>
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="stat">
      <div className="muted small">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="muted small">{hint}</div>}
    </div>
  );
}

function AccountsPage({ accounts, error, onChanged }: { accounts: Account[] | null; error: string | null; onChanged: () => void }) {
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function addAccount(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setBusy(true);
    try {
      await api("/api/accounts", { method: "POST", body: JSON.stringify({ handle }) });
      setHandle("");
      onChanged();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      setFormError(
        code === "invalid_handle" ? "Use 1–30 letters, numbers, dots or underscores." :
        code === "handle_exists" ? "That account is already added." :
        "Couldn't add the account. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Accounts</h1>
          <p className="muted">Instagram accounts MemeOS manages. Each has its own queue, schedule and history.</p>
        </div>
      </header>

      <form className="card add-row" onSubmit={addAccount}>
        <input
          aria-label="Instagram username"
          placeholder="@username"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          maxLength={40}
          required
        />
        <button className="primary" disabled={busy || !handle.trim()}>
          {busy ? "Adding…" : "Add account"}
        </button>
      </form>
      {formError && <div className="alert error" role="alert">{formError}</div>}
      {error && <div className="alert error" role="alert">{error}</div>}

      {accounts === null && <div className="card muted">Loading accounts…</div>}
      {accounts && accounts.length === 0 && !error && (
        <div className="card empty">
          <h2>No accounts yet</h2>
          <p className="muted">Add the Instagram account you want MemeOS to manage. You can add more later.</p>
        </div>
      )}
      {accounts && accounts.length > 0 && (
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Discovery</th>
                <th>Posts / day</th>
                <th>Audio fallback</th>
                <th>Added</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>@{a.handle}</td>
                  <td>{a.discovery_enabled ? "On" : "Off"}</td>
                  <td>{a.posts_per_day}</td>
                  <td>{a.audio_fallback === "hold_for_review" ? "Hold for review" : "Publish without music"}</td>
                  <td className="muted">{new Date(a.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
