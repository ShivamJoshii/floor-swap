import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, shrinkImage, signedUrl, type Product, type Render } from "../lib/supabase";
import type { Ctx } from "../App";
import type { ProposalItem } from "../lib/pdf";

type Output = { path: string; url: string | null };

const DIRECTIONS: [string, string][] = [["auto", "Auto"], ["along", "Front to back"], ["across", "Left to right"], ["diagonal", "Diagonal"]];
const PATTERNS: Record<string, [string, string][]> = {
  plank: [["straight", "Straight"], ["herringbone", "Herringbone"]],
  tile: [["grid", "Grid"], ["offset", "Offset"]],
  carpet: [], other: [],
};

export default function Generate({ ctx }: { ctx: Ctx }) {
  const store = ctx.membership.store_id;
  const [products, setProducts] = useState<Product[]>([]);
  const [swatchUrls, setSwatchUrls] = useState<Record<string, string>>({});
  const [productId, setProductId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [direction, setDirection] = useState("auto");
  const [pattern, setPattern] = useState("");
  const [lead, setLead] = useState({ name: "", phone: "" });
  const [nOpts, setNOpts] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [results, setResults] = useState<{ before: string | null; outputs: Output[]; product: Product; renderId: string; roomPath: string } | null>(null);
  const [history, setHistory] = useState<(Render & { thumb: string | null; product?: { name: string } | null })[]>([]);
  const [zoom, setZoom] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const product = products.find((p) => p.id === productId) ?? null;

  const loadProducts = useCallback(async () => {
    const { data } = await supabase.from("products").select("*").eq("store_id", store).eq("active", true).order("name");
    const list = (data ?? []) as Product[];
    setProducts(list);
    setProductId((cur) => cur && list.some((p) => p.id === cur) ? cur : (list[0]?.id ?? null));
    if (list.length) {
      const { data: urls } = await supabase.storage.from("swatches").createSignedUrls(list.map((p) => p.swatch_path), 3600);
      const map: Record<string, string> = {};
      (urls ?? []).forEach((u, i) => { if (u.signedUrl) map[list[i].id] = u.signedUrl; });
      setSwatchUrls(map);
    }
  }, [store]);

  const loadHistory = useCallback(async () => {
    const { data } = await supabase.from("renders").select("*, product:products(name)").eq("store_id", store).order("created_at", { ascending: false }).limit(12);
    const rows = (data ?? []) as (Render & { product?: { name: string } | null })[];
    const firsts = rows.map((r) => r.outputs?.[0]?.path).filter(Boolean) as string[];
    const map: Record<string, string> = {};
    if (firsts.length) {
      const { data: urls } = await supabase.storage.from("renders").createSignedUrls(firsts, 3600);
      (urls ?? []).forEach((u, i) => { if (u.signedUrl) map[firsts[i]] = u.signedUrl; });
    }
    setHistory(rows.map((r) => ({ ...r, thumb: r.outputs?.[0] ? map[r.outputs[0].path] ?? null : null })));
  }, [store]);

  useEffect(() => { loadProducts(); loadHistory(); }, [loadProducts, loadHistory]);
  useEffect(() => { setPattern(product ? (PATTERNS[product.type]?.[0]?.[0] ?? "") : ""); }, [product?.type, product]);

  function pick(f: File | undefined) {
    if (!f || !f.type.startsWith("image/")) { setErr("Drop a photo (JPG, PNG or HEIC)."); return; }
    setErr(null); setFile(f);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(URL.createObjectURL(f));
  }

  async function generate() {
    if (!file || !product) return;
    setErr(null); setBusy("Uploading photo…");
    try {
      const blob = await shrinkImage(file, 2048, 0.9);
      const roomPath = `${store}/${crypto.randomUUID()}/room.jpg`;
      const up = await supabase.storage.from("rooms").upload(roomPath, blob, { contentType: "image/jpeg" });
      if (up.error) throw new Error("Upload failed: " + up.error.message);
      setBusy(`Rendering ${nOpts} option${nOpts === 1 ? "" : "s"} (15–40 s)…`);
      const { data, error } = await supabase.functions.invoke("generate", {
        body: { store_id: store, product_id: product.id, room_path: roomPath, options: { direction, pattern }, lead_name: lead.name || null, lead_phone: lead.phone || null, num_images: nOpts },
      });
      if (error) {
        let msg = error.message;
        try { const j = await (error as { context?: Response }).context?.json(); if (j?.error) msg = j.error; } catch { /* keep message */ }
        throw new Error(msg);
      }
      const before = await signedUrl("rooms", roomPath);
      setResults({ before, outputs: (data.outputs ?? []) as Output[], product, renderId: data.render_id, roomPath });
      ctx.toast(data.partial ? `${data.partial} Pick the best one.` : "Done. Pick the best one and send it.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null); ctx.refreshBalance(); loadHistory();
    }
  }

  async function openHistory(r: Render & { product?: { name: string } | null }) {
    const [before, ...outs] = await Promise.all([
      signedUrl("rooms", r.room_path),
      ...r.outputs.map((o) => signedUrl("renders", o.path)),
    ]);
    const prod = products.find((p) => p.id === r.product_id) ?? (r.product_id ? ((await supabase.from("products").select("*").eq("id", r.product_id).maybeSingle()).data as Product | null) : null);
    if (!prod) { ctx.toast("That product no longer exists."); return; }
    setResults({ before, outputs: r.outputs.map((o, i) => ({ path: o.path, url: outs[i] })), product: prod, renderId: r.id, roomPath: r.room_path });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function fetchBlob(url: string) { const r = await fetch(url); if (!r.ok) throw new Error("Could not fetch image."); return await r.blob(); }
  async function download(url: string, name: string) {
    try {
      const b = await fetchBlob(url); const a = document.createElement("a");
      a.href = URL.createObjectURL(b); a.download = name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { ctx.toast(e instanceof Error ? e.message : "Download failed."); }
  }
  async function copy(url: string) {
    try {
      const png = fetchBlob(url).then(async (b) => {
        const bmp = await createImageBitmap(b); const c = document.createElement("canvas"); c.width = bmp.width; c.height = bmp.height;
        c.getContext("2d")!.drawImage(bmp, 0, 0); return await new Promise<Blob>((res, rej) => c.toBlob((x) => x ? res(x) : rej(new Error("png")), "image/png"));
      });
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      ctx.toast("Copied. Paste it into the text thread.");
    } catch { ctx.toast("Copy blocked here. Use Download instead."); }
  }

  const safe = (s: string) => s.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 40) || "floor";
  const inProposal = (path: string) => ctx.proposal.some((it) => it.output_path === path);
  function toggleProposal(o: Output) {
    if (!results || !o.url) return;
    if (inProposal(o.path)) { ctx.setProposal((cur) => cur.filter((it) => it.output_path !== o.path)); return; }
    const { product, renderId, roomPath } = results;
    const item: ProposalItem = { render_id: renderId, output_path: o.path, url: o.url, room_path: roomPath, swatchUrl: swatchUrls[product.id] ?? null,
      product: { id: product.id, name: product.name, type: product.type, length_in: product.length_in, width_in: product.width_in, swatch_path: product.swatch_path } };
    ctx.setProposal((cur) => [...cur, item]); ctx.toast(`Added to proposal (${ctx.proposal.length + 1}).`);
  }
  const noCredits = ctx.balance !== null && ctx.balance <= 0;

  return (
    <div className="two">
      <div className="card">
        <h2>New mockup</h2>
        <div
          className={"drop" + (over ? " over" : "") + (preview ? " has" : "")}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files?.[0]); }}
          onClick={() => fileInput.current?.click()}
          role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") fileInput.current?.click(); }}
        >
          {preview && <img src={preview} alt="Room" />}
          <span className="hint">{preview ? "Click or drop to replace" : "Drop the lead's room photo here, or click to choose"}</span>
          <input ref={fileInput} type="file" accept="image/*" onClick={(e) => e.stopPropagation()} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
        </div>

        <div>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="small muted">Product</span>
            {!products.length && <span className="small warn">Add products first (Products tab).</span>}
          </div>
          <div className="catalog">
            {products.map((p) => (
              <div key={p.id} className={"sku" + (p.id === productId ? " on" : "")} role="button" tabIndex={0}
                onClick={() => setProductId(p.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setProductId(p.id); }}>
                <img src={swatchUrls[p.id]} alt="" />
                <div className="nm">{p.name}</div>
                <div className="dm">{p.length_in && p.width_in ? `${p.length_in}×${p.width_in} in` : p.type}</div>
              </div>
            ))}
          </div>
        </div>

        {product && product.type !== "carpet" && (
          <div className="grid2">
            <label className="f">Direction
              <select value={direction} onChange={(e) => setDirection(e.target.value)}>{DIRECTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </label>
            {(PATTERNS[product.type] ?? []).length > 0 && (
              <label className="f">Layout
                <select value={pattern} onChange={(e) => setPattern(e.target.value)}>{PATTERNS[product.type].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
              </label>
            )}
          </div>
        )}

        <div className="grid2">
          <label className="f">Lead name (optional)<input type="text" value={lead.name} onChange={(e) => setLead({ ...lead, name: e.target.value })} /></label>
          <label className="f">Lead phone (optional)<input type="tel" value={lead.phone} onChange={(e) => setLead({ ...lead, phone: e.target.value })} /></label>
        </div>

        <div className="row">
          <span className="small muted">Options</span>
          <div className="seg">{[1, 2, 3].map((n) => <button key={n} type="button" className={nOpts === n ? "on" : ""} onClick={() => setNOpts(n)}>{n}</button>)}</div>
          <span className="small muted">1 is usually enough; more options cost the same credit but take longer.</span>
        </div>
        <button className="primary big" disabled={!file || !product || !!busy || noCredits} onClick={generate}>
          {busy ? <><span className="spinner" /> {busy}</> : noCredits ? "No credits left" : `Generate ${nOpts} option${nOpts === 1 ? "" : "s"} · 1 credit`}
        </button>
        {err && <p className="warn small">{err}</p>}
        {noCredits && <p className="small muted">Top up under Credits.</p>}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
        <div className="card">
          <h2>{results ? `Options · ${results.product.name}` : "Options"}</h2>
          {!results && <p className="muted">Your options show up here. Click any to enlarge, then download, copy, or add it to a proposal.</p>}
          {results && (
            <div className="results">
              {results.before && (
                <div className="result">
                  <img src={results.before} alt="Before" onClick={() => setZoom(results.before)} style={{ cursor: "zoom-in" }} />
                  <div className="bar"><span className="small muted">Before</span></div>
                </div>
              )}
              {results.outputs.map((o, i) => (
                <div className="result" key={o.path}>
                  {o.url ? <img src={o.url} alt={`Option ${i + 1}`} onClick={() => setZoom(o.url)} style={{ cursor: "zoom-in" }} /> : <div className="muted" style={{ padding: 20 }}>Image unavailable</div>}
                  <div className="bar">
                    <span className="small muted grow">Option {i + 1}</span>
                    {o.url && <button className={"sm" + (inProposal(o.path) ? " on" : "")} onClick={() => toggleProposal(o)}>{inProposal(o.path) ? "In proposal ✓" : "+ Proposal"}</button>}
                    {o.url && <button className="sm" onClick={() => download(o.url!, `${safe(results.product.name)}-option-${i + 1}.jpg`)}>Download</button>}
                    {o.url && <button className="sm" onClick={() => copy(o.url!)}>Copy</button>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="card">
          <h2>Recent</h2>
          {!history.length && <p className="muted">Nothing generated yet.</p>}
          {history.length > 0 && (
            <div className="table-wrap"><table>
              <thead><tr><th></th><th>Product</th><th>Lead</th><th>When</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id}>
                    <td>{r.thumb ? <img className="thumb" src={r.thumb} alt="" /> : <div className="thumb" />}</td>
                    <td>{r.product?.name ?? "—"}</td>
                    <td>{r.lead_name || r.lead_phone || "—"}</td>
                    <td className="muted">{new Date(r.created_at).toLocaleString("en-CA", { dateStyle: "short", timeStyle: "short" })}</td>
                    <td><span className={"status " + r.status}>{r.status}</span>{r.status === "failed" && r.error && <div className="small warn">{r.error.slice(0, 80)}</div>}</td>
                    <td>{r.status === "done" && <button className="sm" onClick={() => openHistory(r)}>Open</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          )}
        </div>
      </div>

      {zoom && <div className="lightbox" onClick={() => setZoom(null)}><img src={zoom} alt="" /></div>}
    </div>
  );
}
