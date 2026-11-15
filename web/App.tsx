import { useEffect, useState } from "react";
import { Session, clearSession, loadSession } from "./auth";
import { AuthScreen } from "./AuthScreen";
import { Dashboard } from "./Dashboard";

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setSession(loadSession());
    setReady(true);
  }, []);

  if (!ready) return <div className="boot">Loading MemeOS…</div>;
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
