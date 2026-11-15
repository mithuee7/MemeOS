import { useEffect, useState } from "react";
import { Session, clearSession, loadSession, sessionFromRecoveryHash } from "./auth";
import { AuthScreen } from "./AuthScreen";
import { Dashboard } from "./Dashboard";
import { ResetPassword } from "./ResetPassword";

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [recovery, setRecovery] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const fromLink = sessionFromRecoveryHash();
    if (fromLink) setRecovery(fromLink);
    else setSession(loadSession());
    setReady(true);
  }, []);

  if (!ready) return <div className="boot">Loading MemeOS…</div>;
  if (recovery) return <ResetPassword recovery={recovery} onDone={(s) => { setRecovery(null); setSession(s); }} />;
  if (!session) return <AuthScreen onSignedIn={setSession} />;

  return (
    <Dashboard
      session={session}
      onSignOut={() => {
        clearSession();
        setSession(null);
      }}
    />
  );
}
