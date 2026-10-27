import { useCallback, useEffect, useState } from "react";
import { supabase, signedUrl, type SupplierProduct } from "../lib/supabase";
import { loadBitmap, analyze, rectify, canvasToJpeg, type Quad } from "../lib/image";
import { classify, suggestTags } from "../lib/colour";
import type { Ctx } from "../App";

type Sup = { id: string; name: string; contact_email: string | null; contact_phone: string | null; city: string | null; description: string | null; listed: boolean; claimed: boolean; owner_store_id: string | null };
type Thread = { id: string; from_store_id: string; supplier_product_id: string | null; subject: string | null; status: string; updated_at: string; store?: { name: string; city: string | null; phone: string | null; email: string | null } | null; product?: { name: string; sku: string } | null };
type Msg = { id: number; sender_side: string; body: string; created_at: string };

/** Supplier side: works for a store that also supplies (ctx.membership present) and for standalone supplier accounts (supplierOnly). */
export default function SupplierPage({ ctx, supplierId: forcedId }: { ctx: Ctx | null; supplierId?: string }) {
  const storeId = ctx?.membership.store_id ?? null;
  const [sup, setSup] = useState<Sup | null>(null);
  const [form, setForm] = useState({ name: "", email: "", phone: "", city: "", description: "" });
  const [items, setItems] = useState<SupplierProduct[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [threads, setThreads] = useState<Thread[]>([]);
  const [open, setOpen] = useState<Thread | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToastLocal] = useState<string | null>(null);
  const say = (m: string) => { if (ctx) ctx.toast(m); else { setToastLocal(m); setTimeout(() => setToastLocal(null), 3000); } };
  const [add, setAdd] = useState({ name: "", sku: "", type: "tile", length: "", width: "", finish: "", collection: "", lead_time: "", min_order: "" });
  const [addBmp, setAddBmp] = useState<ImageBitmap | null>(null);

  const load = useCallback(async () => {
    let s: Sup | null = null;
    if (forcedId) { const { data } = await supabase.from("suppliers").select("*").eq("id", forcedId).maybeSingle(); s = data as Sup | null; }
    else if (storeId) { const { data } = await supabase.from("suppliers").select("*").eq("owner_store_id", storeId).maybeSingle(); s = data as Sup | null; }
    setSup(s);
    if (s) {
      setForm({ name: s.name, email: s.contact_email ?? "", phone: s.contact_phone ?? "", city: s.city ?? "", description: s.description ?? "" });
      const [{ data: p }, { data: t }] = await Promise.all([
        supabase.from("supplier_products").select("*").eq("supplier_id", s.id).order("updated_at", { ascending: false }),
        supabase.from("inquiries").select("*, store:stores(name, city, phone, email), product:supplier_products(name, sku)").eq("supplier_id", s.id).order("updated_at", { ascending: false }).limit(100),
      ]);
      const rows = (p ?? []) as SupplierProduct[]; setItems(rows); setThreads((t ?? []) as Thread[]);
      const need = rows.filter((r) => r.swatch_path).slice(0, 120);
      if (need.length) { const { data: u } = await supabase.storage.from("catalog").createSignedUrls(need.map((r) => r.swatch_path!), 3600); const m: Record<string, string> = {}; (u ?? []).forEach((x, i) => { if (x.signedUrl && need[i]) m[need[i].id] = x.signedUrl; }); setUrls(m); }
    } else if (ctx) setForm((f) => ({ ...f, name: ctx.membership.stores.name, email: ctx.membership.stores.email ?? "", phone: ctx.membership.stores.phone ?? "", city: ctx.membership.stores.city ?? "" }));
  }, [forcedId, storeId, ctx]);
  useEffect(() => { load(); }, [load]);

  async function become(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    const { error } = storeId
      ? await supabase.rpc("store_become_supplier", { p_store: storeId, p_name: form.name, p_email: form.email || null, p_phone: form.phone || null, p_city: form.city || null, p_description: form.description || null })
      : await supabase.rpc("create_supplier", { p_name: form.name, p_email: form.email || null, p_phone: form.phone || null, p_city: form.city || null, p_description: form.description || null });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    say("You're listed in the Marketplace."); load();
  }
  async function saveProfile(e: React.FormEvent) {
    e.preventDefault(); if (!sup) return;
    const { error } = await supabase.from("suppliers").update({ name: form.name, contact_email: form.email || null, contact_phone: form.phone || null, city: form.city || null, description: form.description || null }).eq("id", sup.id);
    if (error) { setErr(error.message); return; } say("Saved."); load();
  }
  async function toggleListed() { if (!sup) return; await supabase.from("suppliers").update({ listed: !sup.listed }).eq("id", sup.id); load(); }
  async function toggleItem(p: SupplierProduct & { listed?: boolean }) { await supabase.from("supplier_products").update({ listed: !(p.listed ?? true) }).eq("id", p.id); load(); }
  async function removeItem(p: SupplierProduct) { await supabase.from("supplier_products").delete().eq("id", p.id); load(); }

  async function addListing(e: React.FormEvent) {
    e.preventDefault(); if (!sup) return; setBusy(true); setErr(null);
    try {
      let path: string | null = null; let col = { tone: null as string | null, hue: null as string | null };
      if (addBmp) {
        const q: Quad = [[0, 0], [addBmp.width, 0], [addBmp.width, addBmp.height], [0, addBmp.height]];
        const canvas = rectify(addBmp, q, 2400); const blob = await canvasToJpeg(canvas, 0.9);
        path = `${sup.id}/${crypto.randomUUID()}.jpg`;
        const up = await supabase.storage.from("catalog").upload(path, blob, { contentType: "image/jpeg" }); if (up.error) throw new Error(up.error.message);
        col = classify(addBmp, 0.05); void analyze;
      }
      let len = parseFloat(add.length) || null, wid = parseFloat(add.width) || null; if (len && wid && wid > len) [len, wid] = [wid, len];
      const sug = suggestTags({ name: add.name, type: add.type, collection: add.collection, length_in: len, width_in: wid });
      const { error } = await supabase.from("supplier_products").insert({ supplier_id: sup.id, sku: add.sku.trim(), name: add.name.trim(), type: add.type, length_in: len, width_in: wid, finish: add.finish || null, collection: add.collection || null,
        lead_time: add.lead_time || null, min_order: add.min_order || null, swatch_path: path, tone: col.tone, hue: col.hue, colour_family: col.tone && col.hue ? `${col.tone} ${col.hue}` : null, surfaces: sug.surfaces, rooms: sug.rooms, tags: sug.tags, created_by: (await supabase.auth.getUser()).data.user?.id });
      if (error) throw new Error(error.message.includes("duplicate") ? "That SKU is already listed." : error.message);
      say(`${add.name} listed.`); setAdd({ name: "", sku: "", type: "tile", length: "", width: "", finish: "", collection: "", lead_time: "", min_order: "" }); setAddBmp(null); load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  }
  async function openThread(t: Thread) { setOpen(t); const { data } = await supabase.from("inquiry_messages").select("*").eq("inquiry_id", t.id).order("created_at"); setMsgs((data ?? []) as Msg[]); }
  async function sendReply() {
    if (!open || !reply.trim()) return;
    const { error } = await supabase.rpc("reply_inquiry", { p_inquiry: open.id, p_body: reply }); if (error) { say(error.message); return; }
    setReply(""); openThread(open); load();
  }
  async function closeThread(t: Thread) { await supabase.from("inquiries").update({ status: "closed", updated_at: new Date().toISOString() }).eq("id", t.id); setOpen(null); load(); }

  const isOwner = !ctx || ctx.membership.role === "owner";
  const openLeads = threads.filter((t) => t.status === "open").length;

  if (!sup) {
    return (
      <div className="two">
        <form className="card" onSubmit={become}>
          <h2>{storeId ? "List what you wholesale" : "Set up your supplier profile"}</h2>
          <p className="small">{storeId ? "Other stores on Floor Swap will see your listed products in the Marketplace and can message you for stock and dealer pricing. Your retail prices and your own catalog stay private." : "Stores on Floor Swap browse the Marketplace, render your products on their customers' rooms, and message you for stock and pricing."}</p>
          <label className="f">Supplier name<input type="text" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <div className="grid2">
            <label className="f">Contact email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            <label className="f">Phone<input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
          </div>
          <label className="f">City<input type="text" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></label>
          <label className="f">What you supply<textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Porcelain and ceramic tile, LVP, delivery across Edmonton…" /></label>
          <button className="primary" disabled={busy || !isOwner}>{busy ? <span className="spinner" /> : "List in the Marketplace"}</button>
          {!isOwner && <p className="small muted">Only the store owner can do this.</p>}
          {err && <p className="warn small">{err}</p>}
          <p className="small muted">If your company's catalog is already in the Marketplace (imported from a price list), using the same name claims it.</p>
        </form>
        <div className="card"><h2>Why list</h2><ul className="small" style={{ paddingLeft: 18 }}><li>Every store on Floor Swap can find your products by colour, size, room and type.</li><li>They can render your product on their customer's photo in 30 seconds.</li><li>Inquiries come to you here, with the store's name and contact.</li><li>No prices are shown. You quote.</li></ul></div>
      </div>
    );
  }

  return (
    <div className="two">
      <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}><h2>Leads{openLeads ? ` · ${openLeads} open` : ""}</h2></div>
          {!threads.length && <p className="muted small">No inquiries yet. They show up here when a store asks about one of your listings.</p>}
          {threads.length > 0 && (
            <div className="table-wrap"><table>
              <thead><tr><th>Store</th><th>Product</th><th>Status</th><th>Updated</th><th></th></tr></thead>
              <tbody>{threads.map((t) => (
                <tr key={t.id}>
                  <td><strong>{t.store?.name}</strong>{t.store?.city && <div className="small muted">{t.store.city}</div>}</td>
                  <td className="small">{t.product ? `${t.product.name} · ${t.product.sku}` : t.subject ?? "—"}</td>
                  <td><span className={"status " + (t.status === "open" ? "failed" : t.status === "replied" ? "done" : "")}>{t.status}</span></td>
                  <td className="muted small">{new Date(t.updated_at).toLocaleString("en-CA", { dateStyle: "short", timeStyle: "short" })}</td>
                  <td><button className="sm" onClick={() => openThread(t)}>Open</button></td>
                </tr>))}
              </tbody>
            </table></div>
          )}
        </div>
        {open && (
          <div className="card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <div><h2>{open.store?.name} · {open.product?.name ?? open.subject}</h2><div className="small muted">{[open.store?.phone, open.store?.email].filter(Boolean).join(" · ")}</div></div>
              <div className="row"><button className="sm ghost" onClick={() => closeThread(open)}>Mark closed</button><button className="sm ghost" onClick={() => setOpen(null)}>Close</button></div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 360, overflow: "auto" }}>
              {msgs.map((m) => (
                <div key={m.id} style={{ alignSelf: m.sender_side === "supplier" ? "flex-end" : "flex-start", maxWidth: "85%", background: m.sender_side === "supplier" ? "var(--color-primary)" : "var(--color-frosted)", color: m.sender_side === "supplier" ? "var(--color-on-primary)" : "var(--color-primary)", padding: "8px 12px", borderRadius: 12 }}>
                  <div>{m.body}</div><div className="small" style={{ opacity: .7 }}>{new Date(m.created_at).toLocaleString("en-CA", { dateStyle: "short", timeStyle: "short" })}</div>
                </div>
              ))}
            </div>
            <div className="row"><input type="text" className="grow" value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply with stock, pricing, lead time…" onKeyDown={(e) => { if (e.key === "Enter") sendReply(); }} /><button className="primary sm" onClick={sendReply}>Send</button></div>
          </div>
        )}
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2>Listings · {items.length}</h2>
            <label className="row small"><input type="checkbox" checked={sup.listed} onChange={toggleListed} disabled={!isOwner} /> Visible in Marketplace</label>
          </div>
          {!items.length && <p className="muted small">Nothing listed yet. Add products on the right.</p>}
          {items.length > 0 && (
            <div className="table-wrap"><table>
              <thead><tr><th></th><th>Product</th><th className="num">Size</th><th>Visible</th><th></th></tr></thead>
              <tbody>{items.map((p) => (
                <tr key={p.id} style={{ opacity: (p as SupplierProduct & { listed?: boolean }).listed === false ? .55 : 1 }}>
                  <td><img className="thumb" src={urls[p.id]} alt="" /></td>
                  <td><strong>{p.name}</strong><div className="small muted mono">{p.sku}{p.finish ? ` · ${p.finish}` : ""}</div></td>
                  <td className="num">{p.length_in && p.width_in ? `${p.length_in} × ${p.width_in}` : "—"}</td>
                  <td><button className="sm" onClick={() => toggleItem(p)}>{(p as SupplierProduct & { listed?: boolean }).listed === false ? "Show" : "Hide"}</button></td>
                  <td><button className="sm ghost" onClick={() => removeItem(p)}>Delete</button></td>
                </tr>))}
              </tbody>
            </table></div>
          )}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
        <form className="card" onSubmit={addListing}>
          <h2>Add a listing</h2>
          <div className="grid2">
            <label className="f">Product name<input type="text" required value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} /></label>
            <label className="f">SKU<input type="text" required value={add.sku} onChange={(e) => setAdd({ ...add, sku: e.target.value })} /></label>
          </div>
          <div className="grid3">
            <label className="f">Type<select value={add.type} onChange={(e) => setAdd({ ...add, type: e.target.value })}><option value="tile">Tile</option><option value="plank">Plank</option><option value="carpet">Carpet</option><option value="other">Mosaic / other</option></select></label>
            <label className="f">Length (in)<input type="number" step="0.01" value={add.length} onChange={(e) => setAdd({ ...add, length: e.target.value })} /></label>
            <label className="f">Width (in)<input type="number" step="0.01" value={add.width} onChange={(e) => setAdd({ ...add, width: e.target.value })} /></label>
          </div>
          <div className="grid2">
            <label className="f">Finish<input type="text" value={add.finish} onChange={(e) => setAdd({ ...add, finish: e.target.value })} /></label>
            <label className="f">Collection<input type="text" value={add.collection} onChange={(e) => setAdd({ ...add, collection: e.target.value })} /></label>
          </div>
          <div className="grid2">
            <label className="f">Lead time<input type="text" value={add.lead_time} onChange={(e) => setAdd({ ...add, lead_time: e.target.value })} placeholder="in stock / 2 weeks" /></label>
            <label className="f">Minimum order<input type="text" value={add.min_order} onChange={(e) => setAdd({ ...add, min_order: e.target.value })} placeholder="1 box / 200 sq ft" /></label>
          </div>
          <label className="f">Swatch (scan or product photo)<input type="file" accept="image/*" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setAddBmp(await loadBitmap(f, 3000)); e.target.value = ""; }} /></label>
          {addBmp && <span className="small muted">Image ready · {addBmp.width}×{addBmp.height}</span>}
          <button className="primary" disabled={busy}>{busy ? <span className="spinner" /> : "List product"}</button>
          {err && <p className="warn small">{err}</p>}
        </form>
        <form className="card" onSubmit={saveProfile}>
          <h2>Supplier profile</h2>
          <label className="f">Name<input type="text" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} disabled={!isOwner} /></label>
          <div className="grid2">
            <label className="f">Contact email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} disabled={!isOwner} /></label>
            <label className="f">Phone<input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} disabled={!isOwner} /></label>
          </div>
          <label className="f">City<input type="text" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} disabled={!isOwner} /></label>
          <label className="f">Description<textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} disabled={!isOwner} /></label>
          {isOwner && <button className="sm">Save</button>}
        </form>
      </div>
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
