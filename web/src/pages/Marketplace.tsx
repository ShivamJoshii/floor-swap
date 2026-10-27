import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase, signedUrl, type Product, type Supplier } from "../lib/supabase";
import ProductFilter, { applyFilters, emptyFilters, type Filters } from "../components/ProductFilter";
import type { Ctx } from "../App";

type MP = Product & { supplier_name: string; supplier_city: string | null; supplier_claimed: boolean; owner_store_id: string | null; lead_time: string | null; min_order: string | null; thickness_mm: number | null; updated_at: string };
type Thread = { id: string; supplier_id: string; supplier_product_id: string | null; subject: string | null; status: string; updated_at: string; supplier?: { name: string } | null; product?: { name: string; sku: string } | null };
type Msg = { id: number; sender_side: string; body: string; created_at: string };

export default function Marketplace({ ctx }: { ctx: Ctx }) {
  const store = ctx.membership.stores;
  const [items, setItems] = useState<MP[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [showAll, setShowAll] = useState(false);
  const [sel, setSel] = useState<MP | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [open, setOpen] = useState<Thread | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [reply, setReply] = useState("");

  const load = useCallback(async () => {
    const [{ data }, { data: t }] = await Promise.all([
      supabase.from("marketplace_products").select("*").order("updated_at", { ascending: false }).limit(3000),
      supabase.from("inquiries").select("*, supplier:suppliers(name), product:supplier_products(name, sku)").eq("from_store_id", store.id).order("updated_at", { ascending: false }).limit(50),
    ]);
    setItems(((data ?? []) as unknown as MP[]).map((p) => ({ ...p, swatch_path: p.swatch_path ?? "", store_id: "", price_per_sqft: null, active: true, created_at: p.updated_at })));
    setThreads((t ?? []) as Thread[]);
  }, [store.id]);
  useEffect(() => { load(); }, [load]);

  // Suppliers for the filter chips come from the items themselves.
  const suppliers = useMemo<Supplier[]>(() => {
    const m = new Map<string, Supplier>();
    items.forEach((p) => { if (!m.has(p.supplier_id!)) m.set(p.supplier_id!, { id: p.supplier_id!, name: p.supplier_name, website: null, region: p.supplier_city, store_id: null, created_by: null }); });
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [items]);

  const visible = applyFilters(items, filters) as MP[];
  const shown = showAll ? visible : visible.slice(0, 72);
  useEffect(() => {
    const need = shown.filter((p) => p.swatch_path && !urls[p.id]); if (!need.length) return;
    let cancelled = false;
    supabase.storage.from("catalog").createSignedUrls(need.map((p) => p.swatch_path), 3600).then(({ data: u }) => {
      if (cancelled) return;
      setUrls((cur) => { const m = { ...cur }; (u ?? []).forEach((x, i) => { if (x.signedUrl && need[i]) m[need[i].id] = x.signedUrl; }); return m; });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown.map((p) => p.id).join(",")]);

  async function ask() {
    if (!sel) return; setBusy(true); setNote(null);
    const { data, error } = await supabase.rpc("send_inquiry", { p_store: store.id, p_supplier: sel.supplier_id, p_product: sel.id, p_subject: `${sel.name} (${sel.sku})`, p_body: msg });
    setBusy(false);
    if (error) { setNote(error.message); return; }
    ctx.toast("Sent. The supplier sees it in their Leads."); setMsg(""); setSel(null); load(); void data;
  }
  async function addToMyProducts(p: MP) {
    setBusy(true);
    try {
      let path = "";
      if (p.swatch_path) {
        const u = urls[p.id] ?? (await signedUrl("catalog", p.swatch_path));
        const b = await (await fetch(u!)).blob(); path = `${store.id}/${crypto.randomUUID()}.jpg`;
        const up = await supabase.storage.from("swatches").upload(path, b, { contentType: "image/jpeg" }); if (up.error) throw new Error(up.error.message);
      } else throw new Error("This listing has no swatch yet.");
      const { error } = await supabase.from("products").insert({ store_id: store.id, name: p.name, sku: p.sku, type: p.type, length_in: p.length_in, width_in: p.width_in, finish: p.finish, colour_family: p.colour_family, collection: p.collection,
        supplier_id: p.supplier_id, supplier_product_id: p.id, swatch_path: path, surfaces: p.surfaces ?? ["floor"], rooms: p.rooms ?? [], tone: p.tone, hue: p.hue, tags: p.tags ?? [], created_by: ctx.session.user.id });
      if (error) throw new Error(error.message);
      ctx.toast(`${p.name} added to your products.`);
    } catch (e) { ctx.toast(e instanceof Error ? e.message : String(e)); }
    setBusy(false);
  }
  async function openThread(t: Thread) {
    setOpen(t); const { data } = await supabase.from("inquiry_messages").select("*").eq("inquiry_id", t.id).order("created_at"); setMsgs((data ?? []) as Msg[]);
  }
  async function sendReply() {
    if (!open || !reply.trim()) return;
    const { error } = await supabase.rpc("reply_inquiry", { p_inquiry: open.id, p_body: reply });
    if (error) { ctx.toast(error.message); return; }
    setReply(""); openThread(open); load();
  }

  const unclaimed = (p: MP) => !p.supplier_claimed;

  return (
    <div className="two">
      <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
        <div className="card">
          <h2>Marketplace · {visible.length}{visible.length !== items.length ? ` of ${items.length}` : ""} products from {suppliers.length} suppliers</h2>
          <p className="small muted">Product specs and swatches shared by suppliers and stores on Floor Swap. No prices here; ask the supplier.</p>
          <ProductFilter list={items} suppliers={suppliers} value={filters} onChange={(f) => { setFilters(f); setShowAll(false); }} />
          <div className="catalog" style={{ maxHeight: "none" }}>
            {shown.map((p) => (
              <div key={p.id} className={"sku" + (sel?.id === p.id ? " on" : "")} role="button" tabIndex={0} onClick={() => { setSel(p); setMsg(""); setNote(null); }} onKeyDown={(e) => { if (e.key === "Enter") setSel(p); }}>
                <img src={urls[p.id]} alt="" />
                <div className="nm">{p.name}</div>
                <div className="dm">{p.supplier_name}{p.length_in && p.width_in ? ` · ${p.length_in}×${p.width_in}` : ""}</div>
              </div>
            ))}
          </div>
          {visible.length > shown.length && <button type="button" className="sm ghost" onClick={() => setShowAll(true)}>Show all {visible.length}</button>}
          {!items.length && <p className="muted">Nothing listed yet.</p>}
        </div>

        {threads.length > 0 && (
          <div className="card">
            <h2>Your inquiries</h2>
            <div className="table-wrap"><table>
              <thead><tr><th>Supplier</th><th>Product</th><th>Status</th><th>Updated</th><th></th></tr></thead>
              <tbody>{threads.map((t) => (
                <tr key={t.id}>
                  <td>{t.supplier?.name}</td><td className="small">{t.product ? `${t.product.name} · ${t.product.sku}` : t.subject ?? "—"}</td>
                  <td><span className={"status " + (t.status === "replied" ? "done" : "")}>{t.status}</span></td>
                  <td className="muted small">{new Date(t.updated_at).toLocaleString("en-CA", { dateStyle: "short", timeStyle: "short" })}</td>
                  <td><button className="sm" onClick={() => openThread(t)}>Open</button></td>
                </tr>))}
              </tbody>
            </table></div>
          </div>
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
        {sel && (
          <div className="card">
            <div className="row" style={{ justifyContent: "space-between" }}><h2>{sel.supplier_name}</h2><button className="sm ghost" onClick={() => setSel(null)}>Close</button></div>
            <div className="row" style={{ alignItems: "flex-start" }}>
              <img src={urls[sel.id]} alt="" style={{ width: 160, height: 120, objectFit: "cover", borderRadius: 8, background: "var(--color-frosted-strong)" }} />
              <div className="grow">
                <strong style={{ fontSize: "var(--ts-md)" }}>{sel.name}</strong>
                <div className="small muted mono">{sel.sku}</div>
                <div className="small" style={{ marginTop: 6 }}>
                  {[sel.type, sel.length_in && sel.width_in ? `${sel.length_in}" × ${sel.width_in}"` : null, sel.thickness_mm ? `${sel.thickness_mm} mm` : null, sel.finish, sel.collection].filter(Boolean).join(" · ")}
                </div>
                <div className="row" style={{ gap: 4, marginTop: 6 }}>{[sel.tone && sel.hue ? `${sel.tone} ${sel.hue}` : null, ...(sel.surfaces ?? []), ...(sel.tags ?? [])].filter(Boolean).map((t) => <span key={String(t)} className="pill">{t}</span>)}</div>
                {(sel.lead_time || sel.min_order) && <div className="small muted" style={{ marginTop: 6 }}>{[sel.lead_time && `Lead time: ${sel.lead_time}`, sel.min_order && `Min order: ${sel.min_order}`].filter(Boolean).join(" · ")}</div>}
              </div>
            </div>
            <div className="row">
              <button className="sm" disabled={busy} onClick={() => addToMyProducts(sel)}>Add to my products</button>
              <span className="small muted">Copies the swatch + specs into your catalog so you can render it.</span>
            </div>
            {unclaimed(sel) ? (
              <p className="small muted">{sel.supplier_name} hasn't joined Floor Swap yet, so you can't message them here. Know someone there? Tell them to sign up as a supplier and claim their catalog.</p>
            ) : (
              <>
                <label className="f">Ask {sel.supplier_name}<textarea value={msg} onChange={(e) => setMsg(e.target.value)} placeholder={`Hi, we're ${store.name} in ${store.city ?? "Edmonton"}. Is ${sel.name} in stock, and what's dealer pricing per sq ft?`} /></label>
                <div className="row"><button className="primary" disabled={busy || !msg.trim()} onClick={ask}>{busy ? <span className="spinner" /> : "Send inquiry"}</button>{note && <span className="warn small">{note}</span>}</div>
              </>
            )}
          </div>
        )}
        {open && (
          <div className="card">
            <div className="row" style={{ justifyContent: "space-between" }}><h2>{open.supplier?.name} · {open.product?.name ?? open.subject}</h2><button className="sm ghost" onClick={() => setOpen(null)}>Close</button></div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: 360, overflow: "auto" }}>
              {msgs.map((m) => (
                <div key={m.id} style={{ alignSelf: m.sender_side === "store" ? "flex-end" : "flex-start", maxWidth: "85%", background: m.sender_side === "store" ? "var(--color-primary)" : "var(--color-frosted)", color: m.sender_side === "store" ? "var(--color-on-primary)" : "var(--color-primary)", padding: "8px 12px", borderRadius: 12 }}>
                  <div>{m.body}</div><div className="small" style={{ opacity: .7 }}>{new Date(m.created_at).toLocaleString("en-CA", { dateStyle: "short", timeStyle: "short" })}</div>
                </div>
              ))}
            </div>
            <div className="row"><input type="text" className="grow" value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Reply…" onKeyDown={(e) => { if (e.key === "Enter") sendReply(); }} /><button className="primary sm" onClick={sendReply}>Send</button></div>
          </div>
        )}
        {!sel && !open && (
          <div className="card">
            <h2>How this works</h2>
            <p className="small">Every supplier and store on Floor Swap can list what they sell. Pick a product to see specs, add it to your catalog to render it on a customer's room, or message the supplier for stock and dealer pricing.</p>
            <p className="small">Want to be found here too? Go to <button className="sm ghost" style={{ padding: "0 4px" }} onClick={() => ctx.goTo("supplier")}>Supplier</button> and list what you wholesale.</p>
          </div>
        )}
      </div>
    </div>
  );
}
