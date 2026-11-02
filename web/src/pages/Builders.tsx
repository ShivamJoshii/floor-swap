import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase, signedUrl, type Product, type Supplier } from "../lib/supabase";
import { buildBuilderPdf, type SheetProduct } from "../lib/pdf";
import { makeShowcases } from "../lib/showcase";
import ProductFilter, { applyFilters, emptyFilters, type Filters } from "../components/ProductFilter";
import type { Ctx } from "../App";

type Sheet = { id: string; token: string; builder_name: string | null; builder_company: string | null; builder_phone: string | null; product_ids: string[]; pdf_path: string | null; views: number; last_viewed_at: string | null; created_at: string };

const sheetLink = (token: string) => `${window.location.origin}/b/${token}`;
const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
const safe = (s: string) => s.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 40) || "sheet";

export default function Builders({ ctx }: { ctx: Ctx }) {
  const store = ctx.membership.stores;
  const [list, setList] = useState<Product[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [picked, setPicked] = useState<string[]>([]);
  const [b, setB] = useState({ name: "", company: "", phone: "", email: "", note: "" });
  const [showPrices, setShowPrices] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ link: string; blob: Blob; name: string; phone: string } | null>(null);
  const [sheets, setSheets] = useState<Sheet[]>([]);
  const [sweep, setSweep] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data }, { data: sup }, { data: sh }] = await Promise.all([
      supabase.from("products").select("*").eq("store_id", store.id).eq("active", true).order("name").limit(2000),
      supabase.from("suppliers").select("*").order("name"),
      supabase.from("builder_sheets").select("id, token, builder_name, builder_company, builder_phone, product_ids, pdf_path, views, last_viewed_at, created_at").eq("store_id", store.id).order("created_at", { ascending: false }).limit(25),
    ]);
    setList((data ?? []) as Product[]); setSuppliers((sup ?? []) as Supplier[]); setSheets((sh ?? []) as Sheet[]);
  }, [store.id]);
  useEffect(() => { load(); }, [load]);

  const shown = useMemo(() => applyFilters(list, filters).slice(0, 120), [list, filters]);
  // Thumbnails: room photo when there is one, else the swatch. Signed lazily for what's on screen.
  const tried = useRef(new Set<string>());
  useEffect(() => {
    const need = shown.filter((p) => !tried.current.has(p.id + (p.showcase_path ?? ""))).slice(0, 60);
    if (!need.length) return;
    need.forEach((p) => tried.current.add(p.id + (p.showcase_path ?? "")));
    (async () => {
      const add: Record<string, string> = {};
      const room = need.filter((p) => p.showcase_path), sw = need.filter((p) => !p.showcase_path);
      if (room.length) { const { data } = await supabase.storage.from("renders").createSignedUrls(room.map((p) => p.showcase_path!), 3600); data?.forEach((d, i) => { if (d.signedUrl) add[room[i].id] = d.signedUrl; }); }
      if (sw.length) { const { data } = await supabase.storage.from("swatches").createSignedUrls(sw.map((p) => p.swatch_path), 3600); data?.forEach((d, i) => { if (d.signedUrl) add[sw[i].id] = d.signedUrl; }); }
      if (Object.keys(add).length) setThumbs((cur) => ({ ...cur, ...add }));
    })();
  }, [shown]);

  const withRoom = list.filter((p) => p.showcase_path).length;
  const failedRoom = list.filter((p) => !p.showcase_path && p.showcase_status === "failed").length;
  const toggle = (id: string) => setPicked((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);

  async function makeAll() {
    setSweep("Starting…");
    const r = await makeShowcases(store.id, undefined, (made, left) => setSweep(`Made ${made} · ${left} to go`));
    setSweep(`Made ${r.made} room photo${r.made === 1 ? "" : "s"}${r.failed.length ? ` · ${r.failed.length} failed (bad or missing swatch — retake it)` : ""}.`);
    load();
  }

  async function create() {
    if (!picked.length) { setErr("Pick at least one product."); return; }
    setErr(null); setDone(null);
    try {
      const missing = picked.filter((id) => !list.find((p) => p.id === id)?.showcase_path);
      if (missing.length) {
        setBusy(`Making room photos 0 of ${missing.length}…`);
        await makeShowcases(store.id, missing, (made) => setBusy(`Making room photos ${made} of ${missing.length}…`));
      }
      setBusy("Fetching images…");
      const { data: fresh } = await supabase.from("products").select("*").in("id", picked);
      const byId = new Map(((fresh ?? []) as Product[]).map((p) => [p.id, p]));
      const prods = picked.map((id) => byId.get(id)).filter(Boolean) as Product[];
      const items: SheetProduct[] = await Promise.all(prods.map(async (p) => ({
        name: p.name, sku: p.sku, type: p.type, length_in: p.length_in, width_in: p.width_in, finish: p.finish, collection: p.collection, colour_family: p.colour_family, price_per_sqft: p.price_per_sqft,
        roomUrl: p.showcase_path ? await signedUrl("renders", p.showcase_path) : null,
        swatchUrl: await signedUrl("swatches", p.swatch_path),
      })));
      const logoUrl = store.logo_path ? await signedUrl("brand", store.logo_path) : null;
      setBusy("Laying out the PDF…");
      const bytes = await buildBuilderPdf({ store, builder: { name: b.name.trim(), company: b.company.trim() }, note: b.note, showPrices, items, logoUrl });
      const blob = new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], { type: "application/pdf" });
      setBusy("Saving…");
      const id = crypto.randomUUID(); const token = newToken(); const path = `${store.id}/builders/${id}.pdf`;
      const up = await supabase.storage.from("proposals").upload(path, blob, { contentType: "application/pdf" });
      if (up.error) throw new Error(up.error.message);
      const { error } = await supabase.from("builder_sheets").insert({
        id, token, store_id: store.id, builder_name: b.name.trim() || null, builder_company: b.company.trim() || null, builder_phone: b.phone.trim() || null, builder_email: b.email.trim() || null,
        note: b.note.trim() || null, show_prices: showPrices, product_ids: prods.map((p) => p.id), pdf_path: path, created_by: ctx.session.user.id,
      });
      if (error) throw new Error(error.message);
      const who = b.company.trim() || b.name.trim();
      setDone({ link: sheetLink(token), blob, name: `${safe(store.name)}-products${who ? "-" + safe(who) : ""}.pdf`, phone: b.phone.trim() });
      ctx.toast("Builder sheet ready."); load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  function download(blob: Blob, name: string) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  async function copy(text: string) {
    try { await navigator.clipboard.writeText(text); ctx.toast("Link copied."); } catch { ctx.toast("Copy blocked; select the link text instead."); }
  }
  const smsBody = (link: string) => `Hi${b.name ? " " + b.name.split(" ")[0] : ""}, here are the products we talked about, with photos and specs: ${link} — ${store.name}${store.phone ? " " + store.phone : ""}`;
  async function redownload(s: Sheet) {
    if (!s.pdf_path) return; const u = await signedUrl("proposals", s.pdf_path); if (!u) return;
    download(await (await fetch(u)).blob(), `${safe(store.name)}-products${s.builder_company || s.builder_name ? "-" + safe(s.builder_company || s.builder_name || "") : ""}.pdf`);
  }

  return (
    <div className="two">
      <div className="card">
        <h2>Send to a builder</h2>
        <p className="small muted">For builders and contractors with no room to photograph: each product goes out with a styled room photo and its specs, as a link and a PDF.</p>
        <div className="grid2">
          <label className="f">Name<input type="text" value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} /></label>
          <label className="f">Company<input type="text" value={b.company} onChange={(e) => setB({ ...b, company: e.target.value })} /></label>
          <label className="f">Phone<input type="tel" value={b.phone} onChange={(e) => setB({ ...b, phone: e.target.value })} /></label>
          <label className="f">Email<input type="email" value={b.email} onChange={(e) => setB({ ...b, email: e.target.value })} /></label>
        </div>
        <label className="f">Note on the sheet (optional)<textarea value={b.note} placeholder="e.g. Options for the 12-unit build on 118 Ave. Contractor pricing on request." onChange={(e) => setB({ ...b, note: e.target.value })} /></label>
        <label className="row small"><input type="checkbox" checked={showPrices} onChange={(e) => setShowPrices(e.target.checked)} /> Show $/sq ft (only products with a price set)</label>
        <div className="small"><strong>{picked.length}</strong> product{picked.length === 1 ? "" : "s"} picked{picked.length > 0 && <> · <button className="sm ghost" onClick={() => setPicked([])}>Clear</button></>}</div>
        {picked.length > 0 && (
          <div className="row" style={{ gap: 4 }}>
            {picked.map((id) => { const p = list.find((x) => x.id === id); return p ? <button key={id} className="sm" onClick={() => toggle(id)} title="Remove">{p.name} ×</button> : null; })}
          </div>
        )}
        <button className="primary big" disabled={!picked.length || !!busy} onClick={create}>{busy ? <><span className="spinner" /> {busy}</> : "Create sheet"}</button>
        {err && <p className="warn small">{err}</p>}
        {done && (
          <div className="card">
            <strong>Ready to send</strong>
            <input type="text" readOnly value={done.link} onFocus={(e) => e.currentTarget.select()} />
            <div className="row">
              <button className="primary" onClick={() => copy(done.link)}>Copy link</button>
              {done.phone && <a href={`sms:${done.phone}?&body=${encodeURIComponent(smsBody(done.link))}`}><button>Text it</button></a>}
              <button onClick={() => download(done.blob, done.name)}>Download PDF</button>
              <button className="sm ghost" onClick={() => { setDone(null); setPicked([]); setB({ name: "", company: "", phone: "", email: "", note: "" }); }}>New sheet</button>
            </div>
            <p className="small muted">The link doesn't expire. It shows the room photos, specs and a PDF download.</p>
          </div>
        )}

        <h2 style={{ marginTop: 8 }}>Sent to builders</h2>
        {!sheets.length && <p className="muted small">None yet.</p>}
        {sheets.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th>Builder</th><th>Products</th><th>Opened</th><th></th></tr></thead>
            <tbody>
              {sheets.map((s) => (
                <tr key={s.id}>
                  <td>{s.builder_company || s.builder_name || s.builder_phone || "—"}<div className="small muted">{new Date(s.created_at).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}</div></td>
                  <td>{s.product_ids.length}</td>
                  <td className="small">{s.views ? `${s.views}×` : <span className="muted">not yet</span>}</td>
                  <td className="row" style={{ justifyContent: "flex-end" }}>
                    <button className="sm" onClick={() => copy(sheetLink(s.token))}>Link</button>
                    <button className="sm ghost" onClick={() => redownload(s)}>PDF</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>

      <div className="card">
        <div className="row">
          <h2 className="grow">Pick products</h2>
          <span className="small muted">Room photos: {withRoom} of {list.length}</span>
          {withRoom < list.length && <button className="sm" disabled={!!sweep && !/^Made \d+ room/.test(sweep)} onClick={makeAll}>Make the rest</button>}
        </div>
        {sweep && <p className="small muted">{sweep}</p>}
        {failedRoom > 0 && <p className="small muted">{failedRoom} product{failedRoom === 1 ? "" : "s"} couldn't get a room photo (usually a poor swatch). They're retried when you pick them.</p>}
        <ProductFilter list={list} suppliers={suppliers} value={filters} onChange={setFilters} />
        <div className="catalog" style={{ maxHeight: 620 }}>
          {shown.map((p) => (
            <button key={p.id} type="button" className={"sku" + (picked.includes(p.id) ? " on" : "")} onClick={() => toggle(p.id)} title={p.name}>
              {thumbs[p.id] ? <img src={thumbs[p.id]} alt="" loading="lazy" /> : <img alt="" />}
              <span className="nm">{p.name}</span>
              <span className="dm">{p.showcase_path ? "room photo ✓" : p.showcase_status === "running" ? "making photo…" : "swatch only"}</span>
            </button>
          ))}
        </div>
        {applyFilters(list, filters).length > shown.length && <p className="small muted">Showing the first {shown.length}. Search or filter to narrow it down.</p>}
      </div>
    </div>
  );
}
