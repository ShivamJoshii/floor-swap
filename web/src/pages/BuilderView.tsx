import { useEffect, useState } from "react";
import { specRows } from "../lib/pdf";

// Public page a builder opens from the link. No login; data comes from the builder-sheet edge function.
type Data = {
  store: { name: string; phone: string | null; email: string | null; website: string | null; address: string | null; tagline: string | null; cta_text: string | null; brand_color: string | null; logo_url: string | null };
  sheet: { builder_name: string | null; builder_company: string | null; note: string | null; show_prices: boolean; created_at: string; pdf_url: string | null };
  rooms: { label: string; room_type: string | null; photo_url: string | null; products: { spot: string | null; name: string; sku: string | null; type: string; length_in: number | null; width_in: number | null; finish: string | null; collection: string | null; colour_family: string | null; price_per_sqft: number | null; swatch_url: string | null }[] }[];
};

const URL_BASE = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_KEY as string | undefined;

export default function BuilderView({ token }: { token: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${URL_BASE}/functions/v1/builder-sheet?t=${encodeURIComponent(token)}`, { headers: KEY ? { apikey: KEY } : {} })
      .then(async (r) => { const j = await r.json().catch(() => null); if (!r.ok || !j) throw new Error(j?.error ?? "This link isn't working."); return j as Data; })
      .then((d) => { setData(d); document.title = `${d.store.name} — finishes${d.sheet.builder_company || d.sheet.builder_name ? ` for ${d.sheet.builder_company || d.sheet.builder_name}` : ""}`; })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [token]);

  if (err) return <main className="page"><div className="card"><h2>Link not found</h2><p className="muted">{err === "Not found." ? "This product sheet doesn't exist or was removed. Ask the store for a new link." : err}</p></div></main>;
  if (!data) return <main className="page"><p className="muted">Loading…</p></main>;
  const { store, sheet, rooms } = data;
  const nProducts = new Set(rooms.flatMap((r) => r.products.map((p) => p.name))).size;
  const who = sheet.builder_company || sheet.builder_name;
  const accent = store.brand_color && /^#[0-9a-f]{6}$/i.test(store.brand_color) ? store.brand_color : undefined;

  return (
    <>
      <header className="topbar" style={accent ? { borderTop: `4px solid ${accent}` } : undefined}>
        {store.logo_url ? <img src={store.logo_url} alt={store.name} style={{ height: 32, maxWidth: 160, objectFit: "contain" }} /> : <span className="brand">{store.name}</span>}
        <div className="right">
          {store.phone && <a href={`tel:${store.phone}`}><button className="primary">Call {store.phone}</button></a>}
          {sheet.pdf_url && <a href={sheet.pdf_url} target="_blank" rel="noreferrer"><button>PDF</button></a>}
        </div>
      </header>
      <main className="page">
        <div className="card">
          <h1 style={{ fontSize: "var(--ts-xl)" }}>{who ? `Finishes for ${who}` : "Finishes"}</h1>
          {store.tagline && <p className="muted">{store.tagline}</p>}
          {sheet.note && <p style={{ whiteSpace: "pre-wrap" }}>{sheet.note}</p>}
          <p className="small muted">{rooms.length} room{rooms.length === 1 ? "" : "s"} · {nProducts} product{nProducts === 1 ? "" : "s"} · from {store.name}</p>
        </div>
        {rooms.map((r, i) => (
          <div key={i} className="card">
            <h2>{r.label}</h2>
            {r.photo_url && <img src={r.photo_url} alt={`${r.label} with these finishes`} style={{ width: "100%", borderRadius: 12, display: "block" }} />}
            <div className="results">
              {r.products.map((p, j) => (
                <div key={j} className="row" style={{ alignItems: "flex-start", gap: 12 }}>
                  {p.swatch_url && <img src={p.swatch_url} alt="Sample" style={{ width: 84, height: 84, objectFit: "cover", borderRadius: 8, flex: "none" }} />}
                  <div style={{ minWidth: 0 }}>
                    {p.spot && <div className="small" style={{ textTransform: "uppercase", letterSpacing: ".04em", color: accent ?? "var(--color-contrast-high)" }}>{p.spot}</div>}
                    <strong>{p.name}</strong>
                    <table className="small" style={{ marginTop: 4 }}><tbody>
                      {specRows(p, sheet.show_prices).map(([k, v]) => <tr key={k}><td className="muted" style={{ paddingRight: 12 }}>{k}</td><td>{v}</td></tr>)}
                    </tbody></table>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
        <div className="card">
          <h2>{store.cta_text || "Want samples or a quote?"}</h2>
          <div className="row">
            {store.phone && <a href={`tel:${store.phone}`}><button className="primary">Call {store.phone}</button></a>}
            {store.phone && <a href={`sms:${store.phone}`}><button>Text</button></a>}
            {store.email && <a href={`mailto:${store.email}?subject=${encodeURIComponent("Product sheet" + (who ? " — " + who : ""))}`}><button>Email</button></a>}
          </div>
          {store.address && <p className="small muted">Showroom: {store.address}</p>}
          <p className="small muted">Room photos are AI-styled previews made from the actual product samples. Confirm colour with a physical sample before ordering.</p>
        </div>
      </main>
    </>
  );
}
