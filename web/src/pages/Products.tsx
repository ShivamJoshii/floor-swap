import { useCallback, useEffect, useState } from "react";
import { useRef } from "react";
import { supabase, signedUrl, type Product, type Supplier, type SupplierProduct } from "../lib/supabase";
import { loadBitmap, analyze, rectify, whiteBalance, canvasToJpeg, type Quad, type Quality } from "../lib/image";
import type { Ctx } from "../App";

const empty = { name: "", sku: "", type: "plank", length: "48", width: "7", unit: "in", price: "", notes: "", supplier_id: "", finish: "", colour_family: "", collection: "", share: true, supplier_product_id: "" };
const TYPES: Product["type"][] = ["plank", "tile", "carpet", "other"];

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
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [newSupplier, setNewSupplier] = useState<{ open: boolean; name: string; website: string; shared: boolean }>({ open: false, name: "", website: "", shared: true });
  const [catQ, setCatQ] = useState("");
  const [catHits, setCatHits] = useState<(SupplierProduct & { supplier?: { name: string } | null })[]>([]);
  const [editing, setEditing] = useState<Product | null>(null);
  const [editForm, setEditForm] = useState({ name: "", sku: "", type: "plank", length: "", width: "", finish: "", price: "", notes: "", supplier_id: "" });
  const [editMsg, setEditMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data }, { data: sup }] = await Promise.all([
      supabase.from("products").select("*").eq("store_id", store).order("created_at", { ascending: false }),
      supabase.from("suppliers").select("*").order("name"),
    ]);
    const rows = (data ?? []) as Product[];
    setList(rows); setSuppliers((sup ?? []) as Supplier[]);
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

  useEffect(() => {
    const q = catQ.trim(); if (q.length < 2) { setCatHits([]); return; }
    const t = setTimeout(async () => {
      const { data } = await supabase.from("supplier_products").select("*, supplier:suppliers(name)").or(`name.ilike.%${q}%,sku.ilike.%${q}%`).limit(12);
      setCatHits((data ?? []) as (SupplierProduct & { supplier?: { name: string } | null })[]);
    }, 250);
    return () => clearTimeout(t);
  }, [catQ]);

  async function useCatalogItem(sp: SupplierProduct) {
    setForm((cur) => ({ ...cur, name: sp.name, sku: sp.sku, type: sp.type, unit: "in", length: sp.length_in ? String(sp.length_in) : cur.length, width: sp.width_in ? String(sp.width_in) : cur.width,
      supplier_id: sp.supplier_id, finish: sp.finish ?? "", colour_family: sp.colour_family ?? "", collection: sp.collection ?? "", supplier_product_id: sp.id, share: false }));
    setCatQ(""); setCatHits([]);
    if (sp.swatch_path) {
      const u = await signedUrl("catalog", sp.swatch_path);
      if (u) { try { const b = await loadBitmap(await (await fetch(u)).blob(), 4000); const q: Quad = [[0, 0], [b.width, 0], [b.width, b.height], [0, b.height]]; setBmp(b); setQuad(q); setQuality(analyze(b, q)); } catch { /* user uploads instead */ } }
    }
  }
  async function createSupplier() {
    const name = newSupplier.name.trim(); if (!name) return;
    const { data, error } = await supabase.from("suppliers").insert({ name, website: newSupplier.website.trim() || null, store_id: newSupplier.shared ? null : store, created_by: ctx.session.user.id }).select("*").single();
    if (error) { setErr(error.message.includes("duplicate") ? "That supplier already exists." : error.message); return; }
    setSuppliers((cur) => [...cur, data as Supplier].sort((a, b) => a.name.localeCompare(b.name)));
    setForm((cur) => ({ ...cur, supplier_id: (data as Supplier).id })); setNewSupplier({ open: false, name: "", website: "", shared: true });
  }
  function startEdit(p: Product) {
    setEditing(p); setEditMsg(null);
    setEditForm({ name: p.name, sku: p.sku ?? "", type: p.type, length: p.length_in ? String(p.length_in) : "", width: p.width_in ? String(p.width_in) : "", finish: p.finish ?? "", price: p.price_per_sqft ? String(p.price_per_sqft) : "", notes: p.notes ?? "", supplier_id: p.supplier_id ?? "" });
  }
  async function saveEdit(e: React.FormEvent) {
    e.preventDefault(); if (!editing) return;
    let len = parseFloat(editForm.length) || null, wid = parseFloat(editForm.width) || null; if (len && wid && wid > len) [len, wid] = [wid, len];
    const { error } = await supabase.from("products").update({
      name: editForm.name.trim(), sku: editForm.sku.trim() || null, type: editForm.type, length_in: len, width_in: wid, finish: editForm.finish.trim() || null,
      price_per_sqft: editForm.price ? parseFloat(editForm.price) : null, notes: editForm.notes.trim() || null, supplier_id: editForm.supplier_id || null,
    }).eq("id", editing.id);
    if (error) { setEditMsg(error.message); return; }
    ctx.toast("Saved."); setEditing(null); load();
  }
  async function shareToCatalog(p: Product, blob?: Blob) {
    if (!p.supplier_id || !p.sku) return;
    let catalogPath: string | null = null;
    try {
      const b = blob ?? await (await fetch((await signedUrl("swatches", p.swatch_path)) ?? "")).blob();
      catalogPath = `${ctx.session.user.id}/${crypto.randomUUID()}.jpg`;
      const up = await supabase.storage.from("catalog").upload(catalogPath, b, { contentType: "image/jpeg" });
      if (up.error) catalogPath = null;
    } catch { catalogPath = null; }
    await supabase.from("supplier_products").upsert({
      supplier_id: p.supplier_id, sku: p.sku, name: p.name, type: p.type, length_in: p.length_in, width_in: p.width_in, finish: p.finish ?? null,
      colour_family: p.colour_family ?? null, collection: p.collection ?? null, swatch_path: catalogPath, created_by: ctx.session.user.id,
    }, { onConflict: "supplier_id,sku", ignoreDuplicates: true });
  }

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
      const row = {
        id, store_id: store, name: form.name.trim(), sku: form.sku.trim() || null, type: form.type as Product["type"],
        length_in: needDims ? len : null, width_in: needDims ? wid : null,
        price_per_sqft: form.price ? parseFloat(form.price) : null, notes, swatch_path: path, created_by: ctx.session.user.id,
        supplier_id: form.supplier_id || null, supplier_product_id: form.supplier_product_id || null, finish: form.finish.trim() || null,
        colour_family: form.colour_family.trim() || null, collection: form.collection.trim() || null,
      };
      const { error } = await supabase.from("products").insert(row);
      if (error) throw new Error(error.message);
      if (form.share && row.supplier_id && row.sku) await shareToCatalog({ ...row, active: true, created_at: "" } as Product, blob);
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
      type Item = { name: string; type?: string; sku?: string | null; notes?: string | null; length_in?: number | null; width_in?: number | null; finish?: string | null; collection?: string | null; colour_family?: string | null; supplier?: string | null; jpg_b64: string };
      const items = JSON.parse(await f.text()) as Item[];
      if (!Array.isArray(items)) throw new Error("Not a catalog file.");
      // Resolve / create suppliers named in the file (shared by default).
      const supMap = new Map<string, string>(suppliers.map((su) => [su.name.toLowerCase(), su.id]));
      for (const nm of Array.from(new Set(items.map((it) => (it.supplier ?? "").trim()).filter(Boolean)))) {
        if (supMap.has(nm.toLowerCase())) continue;
        const { data, error } = await supabase.from("suppliers").insert({ name: nm, store_id: null, created_by: ctx.session.user.id }).select("id").single();
        if (!error && data) supMap.set(nm.toLowerCase(), data.id);
        else { const { data: ex } = await supabase.from("suppliers").select("id").ilike("name", nm).limit(1).maybeSingle(); if (ex) supMap.set(nm.toLowerCase(), ex.id); }
      }
      const existingNames = new Set(list.map((p) => p.name.toLowerCase()));
      const existingSkus = new Set(list.filter((p) => p.sku && p.supplier_id).map((p) => `${p.supplier_id}:${p.sku!.toLowerCase()}`));
      let done = 0, skipped = 0, shared = 0; const errors: string[] = [];
      for (let idx = 0; idx < items.length; idx++) {
        const it = items[idx];
        if (!it.name || !it.jpg_b64) { skipped++; continue; }
        const supplierId = it.supplier ? supMap.get(it.supplier.trim().toLowerCase()) ?? null : null;
        const dupKey = supplierId && it.sku ? `${supplierId}:${it.sku.toLowerCase()}` : null;
        if (dupKey ? existingSkus.has(dupKey) : existingNames.has(it.name.toLowerCase())) { skipped++; continue; }
        setImportMsg(`Importing ${idx + 1} of ${items.length}: ${it.name}`);
        const bytes = Uint8Array.from(atob(it.jpg_b64), (c) => c.charCodeAt(0));
        const id = crypto.randomUUID(); const path = `${store}/${id}.jpg`;
        const up = await supabase.storage.from("swatches").upload(path, bytes, { contentType: "image/jpeg" });
        if (up.error) { errors.push(`${it.name}: ${up.error.message}`); continue; }
        const type = (["plank", "tile", "carpet", "other"].includes(it.type ?? "") ? it.type : "tile") as Product["type"];
        const row = { id, store_id: store, name: it.name, type, sku: it.sku ?? null, notes: it.notes ?? null, length_in: it.length_in ?? null, width_in: it.width_in ?? null,
          finish: it.finish ?? null, collection: it.collection ?? null, colour_family: it.colour_family ?? null, supplier_id: supplierId, swatch_path: path, created_by: ctx.session.user.id };
        const { error } = await supabase.from("products").insert(row);
        if (error) { errors.push(`${it.name}: ${error.message}`); continue; }
        done++; if (dupKey) existingSkus.add(dupKey); existingNames.add(it.name.toLowerCase());
        if (supplierId && it.sku) {
          // Share to the supplier catalog (info + swatch, no price). Skip silently if it already exists.
          const { data: ex } = await supabase.from("supplier_products").select("id").eq("supplier_id", supplierId).eq("sku", it.sku).maybeSingle();
          if (!ex) {
            const cpath = `${ctx.session.user.id}/${crypto.randomUUID()}.jpg`;
            const cu = await supabase.storage.from("catalog").upload(cpath, bytes, { contentType: "image/jpeg" });
            const { error: se } = await supabase.from("supplier_products").insert({ supplier_id: supplierId, sku: it.sku, name: it.name, type, length_in: it.length_in ?? null, width_in: it.width_in ?? null,
              finish: it.finish ?? null, collection: it.collection ?? null, colour_family: it.colour_family ?? null, swatch_path: cu.error ? null : cpath, created_by: ctx.session.user.id });
            if (!se) shared++;
          }
        }
      }
      setImportMsg(`Imported ${done}${shared ? `, ${shared} shared to supplier catalog` : ""}${skipped ? `, skipped ${skipped} already there` : ""}${errors.length ? `, ${errors.length} failed: ${errors[0]}` : ""}.`);
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
        <label className="f">Find in supplier catalog
          <input type="text" value={catQ} onChange={(e) => setCatQ(e.target.value)} placeholder="Type a product name or SKU…" />
        </label>
        {catHits.length > 0 && (
          <div className="card" style={{ background: "var(--bg)", padding: 8, gap: 4 }}>
            {catHits.map((h) => (
              <button type="button" key={h.id} className="sm" style={{ textAlign: "left", display: "flex", gap: 8, justifyContent: "space-between" }} onClick={() => useCatalogItem(h)}>
                <span><strong>{h.name}</strong> <span className="muted mono small">{h.sku}</span></span>
                <span className="muted small">{h.supplier?.name}{h.length_in && h.width_in ? ` · ${h.length_in}×${h.width_in}"` : ""}{h.swatch_path ? " · swatch" : ""}</span>
              </button>
            ))}
          </div>
        )}
        <label className="f">Name<input type="text" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Natural Oak 7×48 LVP" /></label>
        <div className="grid2">
          <label className="f">Supplier
            <select value={form.supplier_id} onChange={(e) => e.target.value === "__new" ? setNewSupplier({ ...newSupplier, open: true }) : setForm({ ...form, supplier_id: e.target.value })}>
              <option value="">— none —</option>
              {suppliers.map((su) => <option key={su.id} value={su.id}>{su.name}{su.store_id ? " (private)" : ""}</option>)}
              <option value="__new">+ New supplier…</option>
            </select>
          </label>
          <label className="f">Supplier SKU<input type="text" value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} placeholder="e.g. FBK652" /></label>
        </div>
        {newSupplier.open && (
          <div className="card" style={{ background: "var(--bg)" }}>
            <div className="grid2">
              <label className="f">Supplier name<input type="text" value={newSupplier.name} onChange={(e) => setNewSupplier({ ...newSupplier, name: e.target.value })} /></label>
              <label className="f">Website (optional)<input type="text" value={newSupplier.website} onChange={(e) => setNewSupplier({ ...newSupplier, website: e.target.value })} /></label>
            </div>
            <label className="row small"><input type="checkbox" checked={newSupplier.shared} onChange={(e) => setNewSupplier({ ...newSupplier, shared: e.target.checked })} /> Shared supplier (other stores can pick it)</label>
            <div className="row"><button type="button" className="sm primary" onClick={createSupplier}>Add supplier</button><button type="button" className="sm ghost" onClick={() => setNewSupplier({ ...newSupplier, open: false })}>Cancel</button></div>
          </div>
        )}
        <div className="grid3">
          <label className="f">Finish<input type="text" value={form.finish} onChange={(e) => setForm({ ...form, finish: e.target.value })} placeholder="matte / polished" /></label>
          <label className="f">Colour family<input type="text" value={form.colour_family} onChange={(e) => setForm({ ...form, colour_family: e.target.value })} placeholder="grey, warm oak…" /></label>
          <label className="f">Collection<input type="text" value={form.collection} onChange={(e) => setForm({ ...form, collection: e.target.value })} /></label>
        </div>
        <div className="grid2">
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
        {form.supplier_id && form.sku && <label className="row small"><input type="checkbox" checked={form.share} onChange={(e) => setForm({ ...form, share: e.target.checked })} /> Add this SKU to the shared supplier catalog (no prices are shared)</label>}
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
        {editing && (
          <form className="card" style={{ background: "var(--bg)" }} onSubmit={saveEdit}>
            <div className="row" style={{ justifyContent: "space-between" }}><strong>Edit · {editing.name}</strong><button type="button" className="sm ghost" onClick={() => setEditing(null)}>Close</button></div>
            <div className="grid2">
              <label className="f">Name<input type="text" required value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} /></label>
              <label className="f">Supplier SKU<input type="text" value={editForm.sku} onChange={(e) => setEditForm({ ...editForm, sku: e.target.value })} /></label>
            </div>
            <div className="grid2">
              <label className="f">Supplier<select value={editForm.supplier_id} onChange={(e) => setEditForm({ ...editForm, supplier_id: e.target.value })}><option value="">— none —</option>{suppliers.map((su) => <option key={su.id} value={su.id}>{su.name}</option>)}</select></label>
              <label className="f">Type<select value={editForm.type} onChange={(e) => setEditForm({ ...editForm, type: e.target.value })}>{TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
            </div>
            <div className="grid3">
              <label className="f">Length / long side (in)<input type="number" step="0.01" min="0" value={editForm.length} onChange={(e) => setEditForm({ ...editForm, length: e.target.value })} /></label>
              <label className="f">Width / short side (in)<input type="number" step="0.01" min="0" value={editForm.width} onChange={(e) => setEditForm({ ...editForm, width: e.target.value })} /></label>
              <label className="f">$/sq ft<input type="number" step="0.01" min="0" value={editForm.price} onChange={(e) => setEditForm({ ...editForm, price: e.target.value })} /></label>
            </div>
            <div className="grid2">
              <label className="f">Finish<input type="text" value={editForm.finish} onChange={(e) => setEditForm({ ...editForm, finish: e.target.value })} /></label>
              <label className="f">Notes<input type="text" value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} /></label>
            </div>
            <div className="row">
              <button className="primary sm">Save changes</button>
              {editForm.supplier_id && editForm.sku && <button type="button" className="sm" onClick={async () => { await shareToCatalog({ ...editing, supplier_id: editForm.supplier_id, sku: editForm.sku, name: editForm.name, finish: editForm.finish } as Product); ctx.toast("Added to the supplier catalog."); }}>Share to supplier catalog</button>}
              {editMsg && <span className="warn small">{editMsg}</span>}
            </div>
            <p className="small muted">To replace the swatch image, add the product again with the new scan and hide this one.</p>
          </form>
        )}
        {!shown.length && <p className="muted">No products yet. Add the 5–10 you sell most.</p>}
        {shown.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th></th><th>Name</th><th>Supplier</th><th className="num">Size (in)</th><th className="num">$/sq ft</th><th></th></tr></thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id} style={{ opacity: p.active ? 1 : 0.55 }}>
                  <td><img className="thumb" src={urls[p.id]} alt="" /></td>
                  <td><strong>{p.name}</strong><div className="small muted">{p.type}{p.sku ? <span className="mono"> · {p.sku}</span> : null}{p.finish ? ` · ${p.finish}` : ""}</div></td>
                  <td className="small">{suppliers.find((su) => su.id === p.supplier_id)?.name ?? "—"}</td>
                  <td className="num">{p.length_in && p.width_in ? `${p.length_in} × ${p.width_in}` : "—"}</td>
                  <td className="num">{p.price_per_sqft ?? "—"}</td>
                  <td className="row" style={{ justifyContent: "flex-end" }}>
                    <button className="sm" onClick={() => startEdit(p)}>Edit</button>
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
