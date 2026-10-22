import { useCallback, useEffect, useState } from "react";
import { useRef } from "react";
import { supabase, type Product } from "../lib/supabase";
import { loadBitmap, analyze, rectify, whiteBalance, canvasToJpeg, type Quad, type Quality } from "../lib/image";
import type { Ctx } from "../App";

const empty = { name: "", sku: "", type: "plank", length: "48", width: "7", unit: "in", price: "", notes: "" };

export default function Products({ ctx }: { ctx: Ctx }) {
  const store = ctx.membership.store_id;
  const isOwner = ctx.membership.role === "owner";
  const [list, setList] = useState<Product[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [form, setForm] = useState(empty);
  const [bmp, setBmp] = useState<ImageBitmap | null>(null);
  const [quad, setQuad] = useState<Quad | null>(null);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [wb, setWb] = useState(false);
  const cropRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef(-1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase.from("products").select("*").eq("store_id", store).order("created_at", { ascending: false });
    const rows = (data ?? []) as Product[];
    setList(rows);
    if (rows.length) {
      const { data: u } = await supabase.storage.from("swatches").createSignedUrls(rows.map((p) => p.swatch_path), 3600);
      const map: Record<string, string> = {}; (u ?? []).forEach((x, i) => { if (x.signedUrl) map[rows[i].id] = x.signedUrl; }); setUrls(map);
    }
  }, [store]);
  useEffect(() => { load(); }, [load]);

  const toIn = (v: string) => { const n = parseFloat(v); if (!(n > 0)) return null; return form.unit === "mm" ? n / 25.4 : form.unit === "cm" ? n / 2.54 : n; };

  async function pickSwatch(f: File | undefined) {
    if (!f) return; setErr(null);
    try {
      const b = await loadBitmap(f, 4000);
      const ix = Math.round(b.width * 0.03), iy = Math.round(b.height * 0.03);
      const q: Quad = [[ix, iy], [b.width - ix, iy], [b.width - ix, b.height - iy], [ix, b.height - iy]];
      setBmp(b); setQuad(q); setQuality(analyze(b, q)); setWb(false);
      if (!form.name) setForm((cur) => ({ ...cur, name: f.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").slice(0, 40) }));
    } catch { setErr("Could not read that image. Use a JPG or PNG (iPhone HEIC needs converting)."); }
  }
  const swapLongEdge = () => { if (quad) { const q = [...quad]; q.push(q.shift()!); setQuad(q as Quad); } };

  useEffect(() => {
    const c = cropRef.current; if (!c || !bmp || !quad) return;
    const W = 360, k = W / bmp.width, H = Math.round(bmp.height * k); c.width = W; c.height = H;
    const g = c.getContext("2d")!; g.drawImage(bmp, 0, 0, W, H);
    g.fillStyle = "rgba(0,0,0,0.45)"; g.beginPath(); g.rect(0, 0, W, H); quad.forEach(([x, y], i) => i ? g.lineTo(x * k, y * k) : g.moveTo(x * k, y * k)); g.closePath(); g.fill("evenodd");
    g.strokeStyle = "#ffd166"; g.lineWidth = 3; g.beginPath(); g.moveTo(quad[0][0] * k, quad[0][1] * k); g.lineTo(quad[1][0] * k, quad[1][1] * k); g.stroke();
    g.lineWidth = 1.5; g.beginPath(); quad.forEach(([x, y], i) => i ? g.lineTo(x * k, y * k) : g.moveTo(x * k, y * k)); g.closePath(); g.stroke();
    quad.forEach(([x, y]) => { g.beginPath(); g.arc(x * k, y * k, 7, 0, Math.PI * 2); g.fillStyle = "#ffd166"; g.fill(); g.strokeStyle = "#2a1d0a"; g.stroke(); });
    g.font = "11px sans-serif"; g.fillStyle = "#ffd166"; g.fillText("long edge", (quad[0][0] + quad[1][0]) / 2 * k - 24, (quad[0][1] + quad[1][1]) / 2 * k + 14);
  }, [bmp, quad]);

  const cropPt = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const c = cropRef.current!; const r = c.getBoundingClientRect(); const k = bmp!.width / c.width;
    return [(e.clientX - r.left) * c.width / r.width * k, (e.clientY - r.top) * c.height / r.height * k];
  };
  function cropDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!bmp || !quad) return; const [x, y] = cropPt(e); const tol = bmp.width / 18; let best = -1, bd = tol;
    quad.forEach(([qx, qy], i) => { const d = Math.hypot(qx - x, qy - y); if (d < bd) { bd = d; best = i; } });
    if (best >= 0) { dragRef.current = best; (e.target as HTMLElement).setPointerCapture(e.pointerId); }
  }
  function cropMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (dragRef.current < 0 || !bmp || !quad) return; const [x, y] = cropPt(e);
    const q = quad.map((p, i) => i === dragRef.current ? [Math.max(0, Math.min(bmp.width, x)), Math.max(0, Math.min(bmp.height, y))] : p) as Quad; setQuad(q);
  }
  function cropUp() { if (dragRef.current >= 0 && bmp && quad) setQuality(analyze(bmp, quad)); dragRef.current = -1; }

  async function save(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    if (!bmp || !quad) { setErr("Add a swatch: one plank or tile, straight on, filling the frame."); return; }
    setBusy(true);
    try {
      const needDims = form.type === "plank" || form.type === "tile";
      let len = toIn(form.length), wid = toIn(form.width);
      if (needDims && (!len || !wid)) throw new Error("Enter the plank or tile size.");
      if (len && wid && wid > len) [len, wid] = [wid, len];
      const canvas = rectify(bmp, quad, 3000); if (wb) whiteBalance(canvas);
      const blob = await canvasToJpeg(canvas, 0.92);
      const id = crypto.randomUUID();
      const path = `${store}/${id}.jpg`;
      const up = await supabase.storage.from("swatches").upload(path, blob, { contentType: "image/jpeg" });
      if (up.error) throw new Error(up.error.message);
      const notes = [form.notes.trim(), quality ? `capture score ${quality.score}/100` : ""].filter(Boolean).join(" · ") || null;
      const { error } = await supabase.from("products").insert({
        id, store_id: store, name: form.name.trim(), sku: form.sku.trim() || null, type: form.type,
        length_in: needDims ? len : null, width_in: needDims ? wid : null,
        price_per_sqft: form.price ? parseFloat(form.price) : null, notes, swatch_path: path, created_by: ctx.session.user.id,
      });
      if (error) throw new Error(error.message);
      ctx.toast(`${form.name} added.`);
      setForm(empty); setBmp(null); setQuad(null); setQuality(null);
      load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const [importMsg, setImportMsg] = useState<string | null>(null);
  async function importCatalog(f: File | undefined) {
    if (!f) return;
    setImportMsg("Reading file…");
    try {
      const items = JSON.parse(await f.text()) as { name: string; type?: string; sku?: string | null; notes?: string | null; length_in?: number | null; width_in?: number | null; jpg_b64: string }[];
      if (!Array.isArray(items)) throw new Error("Not a catalog file.");
      const existing = new Set(list.map((p) => p.name.toLowerCase()));
      let done = 0, skipped = 0; const errors: string[] = [];
      for (const it of items) {
        if (!it.name || !it.jpg_b64) { skipped++; continue; }
        if (existing.has(it.name.toLowerCase())) { skipped++; continue; }
        setImportMsg(`Importing ${done + 1} of ${items.length}: ${it.name}`);
        const bytes = Uint8Array.from(atob(it.jpg_b64), (c) => c.charCodeAt(0));
        const id = crypto.randomUUID(); const path = `${store}/${id}.jpg`;
        const up = await supabase.storage.from("swatches").upload(path, bytes, { contentType: "image/jpeg" });
        if (up.error) { errors.push(`${it.name}: ${up.error.message}`); continue; }
        const type = ["plank", "tile", "carpet", "other"].includes(it.type ?? "") ? it.type : "tile";
        const { error } = await supabase.from("products").insert({ id, store_id: store, name: it.name, type, sku: it.sku ?? null, notes: it.notes ?? null, length_in: it.length_in ?? null, width_in: it.width_in ?? null, swatch_path: path, created_by: ctx.session.user.id });
        if (error) errors.push(`${it.name}: ${error.message}`); else done++;
      }
      setImportMsg(`Imported ${done}${skipped ? `, skipped ${skipped} already there` : ""}${errors.length ? `, ${errors.length} failed: ${errors[0]}` : ""}.`);
      ctx.toast(`Imported ${done} products.`); load();
    } catch (e) { setImportMsg(e instanceof Error ? e.message : String(e)); }
  }

  async function toggle(p: Product) {
    await supabase.from("products").update({ active: !p.active }).eq("id", p.id); load();
  }
  async function remove(p: Product) {
    if (!isOwner) return;
    await supabase.from("products").delete().eq("id", p.id);
    await supabase.storage.from("swatches").remove([p.swatch_path]);
    ctx.toast(`${p.name} removed.`); load();
  }

  const needDims = form.type === "plank" || form.type === "tile";
  const shown = list.filter((p) => showInactive || p.active);

  return (
    <div className="two">
      <form className="card" onSubmit={save}>
        <h2>Add product</h2>
        <label className="f">Name<input type="text" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Natural Oak 7×48 LVP" /></label>
        <div className="grid2">
          <label className="f">SKU (optional)<input type="text" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} /></label>
          <label className="f">Type
            <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value, length: e.target.value === "tile" ? "24" : "48", width: e.target.value === "tile" ? "12" : "7" })}>
              <option value="plank">Plank (LVP / laminate / hardwood)</option><option value="tile">Tile</option><option value="carpet">Carpet</option><option value="other">Other</option>
            </select>
          </label>
        </div>
        {needDims && (
          <div className="grid3">
            <label className="f">{form.type === "tile" ? "Long side" : "Length"}<input type="number" step="0.01" min="0.1" value={form.length} onChange={(e) => setForm({ ...form, length: e.target.value })} /></label>
            <label className="f">{form.type === "tile" ? "Short side" : "Width"}<input type="number" step="0.01" min="0.1" value={form.width} onChange={(e) => setForm({ ...form, width: e.target.value })} /></label>
            <label className="f">Unit<select value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })}><option value="in">in</option><option value="mm">mm</option><option value="cm">cm</option></select></label>
          </div>
        )}
        <div className="grid2">
          <label className="f">Price per sq ft (optional)<input type="number" step="0.01" min="0" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></label>
          <label className="f">Swatch scan or photo<input type="file" accept="image/*" onChange={(e) => { pickSwatch(e.target.files?.[0]); e.target.value = ""; }} /></label>
        </div>
        {bmp && quad && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <canvas ref={cropRef} id="swatchCrop" style={{ width: "100%", maxWidth: 360, touchAction: "none", cursor: "grab", borderRadius: 4 }}
              onPointerDown={cropDown} onPointerMove={cropMove} onPointerUp={cropUp} onPointerCancel={cropUp} />
            <div className="row">
              <button type="button" className="sm" onClick={swapLongEdge}>Swap long edge</button>
              <label className="row small"><input type="checkbox" checked={wb} onChange={(e) => setWb(e.target.checked)} /> Neutralize colour cast</label>
              {quality && <span className={"pill small"} style={{ background: quality.score >= 70 ? "#d8eadf" : quality.score >= 40 ? "var(--accent-soft)" : "#f6d9cf" }}>Capture {quality.score}/100 · {quality.width}×{quality.height}</span>}
            </div>
            {quality?.warnings.map((w) => <p key={w} className="small warn">{w}</p>)}
            <p className="small muted">Drag the dots to the edges of one plank or tile. Top edge = long edge. Straighter crop, better render.</p>
          </div>
        )}
        <p className="small muted">Best input: a flatbed scan at 600 dpi, or a straight-down daylight photo with the sample filling the frame. The capture score tells staff if it's good enough.</p>
        <label className="f">Notes (optional)<textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Colour family, finish, where it's stocked…" /></label>
        <button className="primary" disabled={busy}>{busy ? <span className="spinner" /> : "Save product"}</button>
        {err && <p className="warn small">{err}</p>}
      </form>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2>Catalog · {list.filter((p) => p.active).length} active</h2>
          <label className="row small muted"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> show hidden</label>
        </div>
        <div className="row">
          <label className="sm" style={{ display: "inline-block" }}>
            <span className="small muted">Import catalog file (.json): </span>
            <input type="file" accept="application/json,.json" style={{ width: "auto" }} onChange={(e) => { importCatalog(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          {importMsg && <span className="small">{importMsg}</span>}
        </div>
        {!shown.length && <p className="muted">No products yet. Add the 5–10 you sell most.</p>}
        {shown.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th></th><th>Name</th><th>Type</th><th className="num">Size (in)</th><th className="num">$/sq ft</th><th></th></tr></thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id} style={{ opacity: p.active ? 1 : 0.55 }}>
                  <td><img className="thumb" src={urls[p.id]} alt="" /></td>
                  <td><strong>{p.name}</strong>{p.sku && <div className="small muted mono">{p.sku}</div>}</td>
                  <td>{p.type}</td>
                  <td className="num">{p.length_in && p.width_in ? `${p.length_in} × ${p.width_in}` : "—"}</td>
                  <td className="num">{p.price_per_sqft ?? "—"}</td>
                  <td className="row" style={{ justifyContent: "flex-end" }}>
                    <button className="sm" onClick={() => toggle(p)}>{p.active ? "Hide" : "Show"}</button>
                    {isOwner && <button className="sm ghost" onClick={() => remove(p)}>Delete</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
