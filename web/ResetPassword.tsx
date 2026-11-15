import { FormEvent, useState } from "react";
import { Session, saveSession, updatePassword } from "./auth";

// Shown when the user arrives from a password reset email.
export function ResetPassword({ recovery, onDone }: { recovery: Session; onDone: (s: Session) => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) return setError("Password must be at least 8 characters.");
    if (password !== confirm) return setError("Passwords don't match.");
    setBusy(true);
    try {
      const email = await updatePassword(recovery.accessToken, password);
      const session = { ...recovery, email };
      saveSession(session);
      onDone(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't update password.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="brand"><span className="brand-mark" />MemeOS</div>
        <h1>Choose a new password</h1>
        <p className="muted">Enter a new password for your account.</p>
        <form onSubmit={submit} className="stack">
          <label><span>New password</span>
            <input type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label><span>Confirm password</span>
            <input type="password" autoComplete="new-password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </label>
          {error && <div className="alert error" role="alert">{error}</div>}
          <button className="primary" disabled={busy}>{busy ? "Saving…" : "Save new password"}</button>
        </form>
      </div>
    </div>
  );
}
