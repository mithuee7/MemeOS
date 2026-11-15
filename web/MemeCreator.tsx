import { useEffect, useRef, useState } from "react";
import { api } from "./api";

interface Meme { id: number; extracted_text: string | null; edited_text: string | null; status: string }

// Black-and-white text card rendered in the browser. Source-image compositing and MP4 are not built yet.
function drawCard(canvas: HTMLCanvasElement, text: string) {
  const size = 1080;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#000000";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const lines = wrap(ctx, text.toLowerCase() || " ", size - 160, 92);
  const lineHeight = 104;
  const top = (size - lines.length * lineHeight) / 2;
  lines.forEach((line, i) => ctx.fillText(line, 80, top + i * lineHeight));
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, fontSize: number): string[] {
  ctx.font = `700 ${fontSize}px Inter, system-ui, sans-serif`;
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) {
        out.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    out.push(line);
  }
  return out;
}

export function MemeCreatorPage() {
  const [memes, setMemes] = useState<Meme[] | null>(null);
  const [selected, setSelected] = useState<Meme | null>(null);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    api<{ items: Meme[] }>("/api/library?limit=100")
      .then((d) => setMemes(d.items))
      .catch(() => setMemes([]));
  }, []);

  useEffect(() => {
    if (canvas.current) drawCard(canvas.current, text);
  }, [text]);

  function pick(m: Meme) {
    setSelected(m);
    setText(m.edited_text ?? m.extracted_text ?? "");
    setNotice(null);
  }

  async function save() {
    if (!selected) return;
    try {
      await api(`/api/memes/${selected.id}`, { method: "PATCH", body: JSON.stringify({ edited_text: text }) });
      setNotice({ kind: "ok", text: "Text saved." });
    } catch {
      setNotice({ kind: "error", text: "Couldn't save the text. Try again." });
    }
  }

  function download() {
    if (!canvas.current) return;
    const a = document.createElement("a");
    a.href = canvas.current.toDataURL("image/png");
    a.download = `memeos-${selected?.id ?? "card"}.png`;
    a.click();
  }

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>Meme Creator</h1>
          <p className="muted">Edit a meme's text and preview a black-and-white card. Download it as a PNG.</p>
        </div>
      </header>

      {notice && <div className={`alert ${notice.kind}`} role="status">{notice.text}</div>}

      <div className="creator">
        <div className="card creator-list">
          <h2>Memes</h2>
          {memes === null && <p className="muted">Loading…</p>}
          {memes && memes.length === 0 && <p className="muted">No memes yet. Run discovery first.</p>}
          {memes?.map((m) => (
            <button key={m.id} className={`creator-pick ${selected?.id === m.id ? "on" : ""}`} onClick={() => pick(m)}>
              <span className="small muted">#{m.id} · {m.status}</span>
              <span>{(m.edited_text ?? m.extracted_text ?? "No text").slice(0, 60)}</span>
            </button>
          ))}
        </div>

        <div className="card creator-edit">
          {!selected && <p className="muted">Pick a meme to edit it.</p>}
          {selected && (
            <>
              <label>
                <span>Text</span>
                <textarea value={text} onChange={(e) => setText(e.target.value)} rows={5} maxLength={2000} />
              </label>
              <div className="row-actions">
                <button className="secondary" onClick={save}>Save text</button>
                <button className="primary" onClick={download}>Download PNG</button>
              </div>
            </>
          )}
          <canvas ref={canvas} className="preview" aria-label="Meme preview" />
        </div>
      </div>
    </section>
  );
}
