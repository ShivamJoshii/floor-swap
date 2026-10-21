import { useCallback, useEffect, useState } from "react";
import { supabase, shrinkImage, type Product } from "../lib/supabase";
import type { Ctx } from "../App";

const empty = { name: "", sku: "", type: "plank", length: "48", width: "7", unit: "in", price: "", notes: "" };

export default function Products({ ctx }: { ctx: Ctx }) {
  const store = ctx.membership.store_id;
  const isOwner = ctx.membership.role === "owner";
  const [list, setList] = useState<Product[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [form, setForm] = useState(empty);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
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

  async function save(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    if (!file) { setErr("Add a swatch photo: one plank or tile, straight on, filling the frame."); return; }
    setBusy(true);
    try {
      const blob = await shrinkImage(file, 1600, 0.92);
      const id = crypto.randomUUID();
      const path = `${store}/${id}.jpg`;
      const up = await supabase.storage.from("swatches").upload(path, blob, { contentType: "image/jpeg" });
      if (up.error) throw new Error(up.error.message);
      const needDims = form.type === "plank" || form.type === "tile";
      let len = toIn(form.length), wid = toIn(form.width);
      if (needDims && (!len || !wid)) throw new Error("Enter the plank or tile size.");
      if (len && wid && wid > len) [len, wid] = [wid, len];
      const { error } = await supabase.from("products").insert({
        id, store_id: store, name: form.name.trim(), sku: form.sku.trim() || null, type: form.type,
        length_in: needDims ? len : null, width_in: needDims ? wid : null,
        price_per_sqft: form.price ? parseFloat(form.price) : null, notes: form.notes.trim() || null, swatch_path: path, created_by: ctx.session.user.id,
      });
      if (error) throw new Error(error.message);
      ctx.toast(`${form.name} added.`);
      setForm(empty); setFile(null); if (preview) URL.revokeObjectURL(preview); setPreview(null);
      load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
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
          <label className="f">Swatch photo<input type="file" accept="image/*" onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (preview) URL.revokeObjectURL(preview); setPreview(f ? URL.createObjectURL(f) : null); }} /></label>
        </div>
        {preview && <img src={preview} alt="Swatch preview" style={{ maxHeight: 160, objectFit: "contain", borderRadius: 6, background: "#222" }} />}
        <p className="small muted">Best swatch: one plank or tile, shot straight down, filling the frame, no background. The supplier's product photo usually works.</p>
        <label className="f">Notes (optional)<textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Colour family, finish, where it's stocked…" /></label>
        <button className="primary" disabled={busy}>{busy ? <span className="spinner" /> : "Save product"}</button>
        {err && <p className="warn small">{err}</p>}
      </form>

      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2>Catalog · {list.filter((p) => p.active).length} active</h2>
          <label className="row small muted"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> show hidden</label>
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
