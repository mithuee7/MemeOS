import { useEffect, useState } from "react";
import { api } from "./api";

interface Provider { provider: string; configured: boolean; source: string | null }
interface Item { status: string }

// Analytics only shows real data. Metrics come from Meta Insights after a connected account publishes.
export function AnalyticsPage() {
  const [metaReady, setMetaReady] = useState<boolean | null>(null);
  const [published, setPublished] = useState<number | null>(null);

  useEffect(() => {
    api<{ integrations: Provider[] }>("/api/integrations")
      .then((d) => setMetaReady(d.integrations.some((p) => p.provider === "meta" && p.configured)))
      .catch(() => setMetaReady(false));
    api<{ items: Item[] }>("/api/publish-history?status=published&limit=100")
      .then((d) => setPublished(d.items.length))
      .catch(() => setPublished(0));
  }, []);

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Analytics</h1>
          <p className="muted">Reach, engagement and follower metrics come from Meta Insights. Nothing is estimated.</p>
        </div>
      </header>
      <div className="stat-grid">
        <div className="stat">
          <div className="muted small">Meta connection</div>
          <div className="stat-value">{metaReady === null ? "—" : metaReady ? "Connected" : "Not connected"}</div>
          <div className="muted small">{metaReady ? "Insights can be fetched." : "Add your Meta credentials in Settings."}</div>
        </div>
        <div className="stat">
          <div className="muted small">Published posts</div>
          <div className="stat-value">{published ?? "—"}</div>
          <div className="muted small">From Publishing History.</div>
        </div>
      </div>
      <div className="card empty" style={{ marginTop: 14 }}>
        <h2>No metrics yet</h2>
        <p className="muted">Metrics appear after posts are published and the Meta Insights fetch runs. Until then this page stays empty on purpose.</p>
      </div>
    </section>
  );
}
