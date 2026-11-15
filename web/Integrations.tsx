import { FormEvent, useCallback, useEffect, useState } from "react";
import { ApiError, api } from "./api";

type Provider = "apify" | "groq" | "meta";

interface Integration {
  provider: Provider;
  configured: boolean;
  source: "saved" | "worker_secret" | null;
  last4: string | null;
  status: "untested" | "ok" | "failed" | "not_configured";
  status_detail: string | null;
  tested_at: string | null;
}

const LABELS: Record<Provider, { name: string; help: string }> = {
  apify: { name: "Apify", help: "Used for discovering public Instagram posts. Create a token at Apify → Settings → Integrations." },
  groq: { name: "Groq", help: "Used for text extraction and classification. Create a key at console.groq.com." },
  meta: { name: "Meta (Instagram Graph API)", help: "Used for publishing. Needs a long-lived access token with publishing permissions." },
};

const ERRORS: Record<string, string> = {
  encryption_not_configured: "Encryption isn't set up on the server yet. Add the CREDENTIALS_KEY secret first.",
  invalid_key: "That doesn't look like a valid key. Paste it without spaces.",
  unauthorised: "Your session expired. Sign in again.",
  forbidden: "Only administrators can change connections.",
};

function message(err: unknown): string {
  return err instanceof ApiError ? (ERRORS[err.code] ?? "Something went wrong.") : "Something went wrong.";
}

export function IntegrationsCard() {
  const [items, setItems] = useState<Integration[] | null>(null);
  const [encryptionReady, setEncryptionReady] = useState(true);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ integrations: Integration[]; encryption_ready: boolean }>("/api/integrations");
      setItems(data.integrations);
      setEncryptionReady(data.encryption_ready);
    } catch (err) {
      setNotice({ kind: "error", text: message(err) });
      setItems([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="card integrations">
      <h2>Connections</h2>
      <p className="muted small">Keys are encrypted on the server. Only the last four characters are shown after saving.</p>
      {!encryptionReady && (
        <div className="alert error" role="alert">
          Encryption isn't set up. Add the CREDENTIALS_KEY secret to the Worker before saving keys.
        </div>
      )}
      {notice && <div className={`alert ${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</div>}
      {items === null && <p className="muted">Loading connections…</p>}
      {items?.map((i) => (
        <ProviderRow key={i.provider} item={i} disabled={!encryptionReady} onChanged={load} onNotice={setNotice} />
      ))}
    </section>
  );
}

function ProviderRow({
  item,
  disabled,
  onChanged,
  onNotice,
}: {
  item: Integration;
  disabled: boolean;
  onChanged: () => void;
  onNotice: (n: { kind: "ok" | "error"; text: string } | null) => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "remove" | null>(null);
  const meta = LABELS[item.provider];

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy("save");
    onNotice(null);
    try {
      await api(`/api/integrations/${item.provider}`, { method: "PUT", body: JSON.stringify({ value }) });
      setValue("");
      onNotice({ kind: "ok", text: `${meta.name} key saved. Run Test to check it.` });
      onChanged();
    } catch (err) {
      onNotice({ kind: "error", text: message(err) });
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy("test");
    onNotice(null);
    try {
      const r = await api<{ status: "ok" | "failed"; detail: string }>(`/api/integrations/${item.provider}/test`, { method: "POST" });
      onNotice({ kind: r.status === "ok" ? "ok" : "error", text: `${meta.name}: ${r.detail}` });
      onChanged();
    } catch (err) {
      onNotice({ kind: "error", text: message(err) });
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!window.confirm(`Remove the saved ${meta.name} key? Features that use it will stop working.`)) return;
    setBusy("remove");
    try {
      await api(`/api/integrations/${item.provider}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      onNotice({ kind: "error", text: message(err) });
    } finally {
      setBusy(null);
    }
  }

  const statusLabel =
    item.status === "ok" ? "Connected" :
    item.status === "failed" ? "Failed" :
    item.configured ? "Saved, not tested" : "Not connected";

  return (
    <div className="integration">
      <div className="integration-head">
        <div>
          <strong>{meta.name}</strong>
          <div className="muted small">{meta.help}</div>
        </div>
        <span className={`pill ${item.status}`}>{statusLabel}</span>
      </div>

      {item.configured && (
        <div className="muted small">
          {item.source === "worker_secret" ? "Set as a Worker secret." : `Saved key ends in ${item.last4}.`}
          {item.status_detail && <> {item.status_detail}</>}
        </div>
      )}

      <form className="add-row" onSubmit={save}>
        <input
          type="password"
          autoComplete="off"
          aria-label={`${meta.name} key`}
          placeholder={item.configured ? "Paste a new key to replace" : "Paste key"}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={disabled || busy !== null}
        />
        <button className="primary" disabled={disabled || busy !== null || value.trim().length < 8}>
          {busy === "save" ? "Saving…" : "Save key"}
        </button>
        <button type="button" className="secondary" onClick={test} disabled={!item.configured || busy !== null}>
          {busy === "test" ? "Testing…" : "Test"}
        </button>
        {item.source === "saved" && (
          <button type="button" className="link danger" onClick={remove} disabled={busy !== null}>Remove</button>
        )}
      </form>
    </div>
  );
}
