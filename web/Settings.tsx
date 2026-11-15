import { FormEvent, useState } from "react";
import { Session, loadSession, updatePassword } from "./auth";
import { IntegrationsCard } from "./Integrations";

export function SettingsPage({ session }: { session: Session }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    if (password !== confirm) return setError("Passwords don't match.");
    setBusy(true);
    try {
      const current = loadSession() ?? session;
      await updatePassword(current.accessToken, password);
      setPassword("");
      setConfirm("");
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">Account and security for {session.email}.</p>
        </div>
      </header>
      <form className="card stack" onSubmit={changePassword} style={{ maxWidth: 420 }}>
        <h2>Change password</h2>
        <label><span>New password</span>
          <input type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label><span>Confirm new password</span>
          <input type="password" autoComplete="new-password" minLength={8} required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        {error && <div className="alert error" role="alert">{error}</div>}
        {done && <div className="alert ok" role="status">Password updated.</div>}
        <button className="primary" disabled={busy}>{busy ? "Saving…" : "Update password"}</button>
      </form>
      <IntegrationsCard />
    </section>
  );
}
