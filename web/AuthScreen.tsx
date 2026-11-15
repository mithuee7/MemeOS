import { FormEvent, useState } from "react";
import { Session, requestPasswordReset, signIn, signUp } from "./auth";

type Mode = "signin" | "signup" | "reset";

export function AuthScreen({ onSignedIn }: { onSignedIn: (s: Session) => void }) {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (mode === "signin") {
        onSignedIn(await signIn(email, password));
      } else if (mode === "signup") {
        if (password.length < 8) throw new Error("Password must be at least 8 characters.");
        const result = await signUp(email, password);
        if (result.needsConfirmation) {
          setNotice("Account created. Check your email to confirm, then sign in.");
          setMode("signin");
        } else {
          onSignedIn((await signIn(email, password)));
        }
      } else {
        await requestPasswordReset(email);
        setNotice("If that email exists, a reset link is on its way.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const title = { signin: "Sign in", signup: "Create account", reset: "Reset password" }[mode];

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="brand">
          <span className="brand-mark" />
          MemeOS
        </div>
        <h1>{title}</h1>
        <p className="muted">
          {mode === "signin" && "Manage your meme accounts, approvals and publishing."}
          {mode === "signup" && "Create the account that will own this MemeOS workspace."}
          {mode === "reset" && "We'll email you a link to choose a new password."}
        </p>

        <form onSubmit={submit} className="stack">
          <label>
            <span>Email</span>
            <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          {mode !== "reset" && (
            <label>
              <span>Password</span>
              <input
                type="password"
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                required
                minLength={mode === "signup" ? 8 : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          )}
          {error && <div className="alert error" role="alert">{error}</div>}
          {notice && <div className="alert ok" role="status">{notice}</div>}
          <button className="primary" disabled={busy}>
            {busy ? "Please wait…" : title}
          </button>
        </form>

        <div className="auth-links">
          {mode !== "signin" && <button className="link" onClick={() => setMode("signin")}>Back to sign in</button>}
          {mode === "signin" && <button className="link" onClick={() => setMode("signup")}>Create account</button>}
          {mode === "signin" && <button className="link" onClick={() => setMode("reset")}>Forgot password?</button>}
        </div>
      </div>
    </div>
  );
}
