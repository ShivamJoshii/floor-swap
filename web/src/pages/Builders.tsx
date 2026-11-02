import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase, signedUrl, type Product, type Supplier } from "../lib/supabase";
import { buildBuilderPdf, type SheetRoom } from "../lib/pdf";
import { ROOM_TYPES, SPOT_LABEL, roomType, fitsSpot, comboOf, type RoomDraft, type Spot } from "../lib/rooms";
import ProductFilter, { applyFilters, emptyFilters, type Filters } from "../components/ProductFilter";
import type { Ctx } from "../App";

type Sheet = { id: string; token: string; builder_name: string | null; builder_company: string | null; builder_phone: string | null; product_ids: string[]; rooms: unknown[] | null; pdf_path: string | null; views: number; created_at: string };
type RenderRes = { id: string; path: string; url: string | null; cached: boolean };

const sheetLink = (token: string) => `${window.location.origin}/b/${token}`;
const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
const safe = (s: string) => s.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 40) || "sheet";
const newRoom = (type = "kitchen"): RoomDraft => ({ key: crypto.randomUUID(), label: roomType(type).label, room_type: type, spots: {} });

export default function Builders({ ctx }: { ctx: Ctx }) {
  const store = ctx.membership.stores;
  const [list, setList] = useState<Product[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [showAll, setShowAll] = useState(false);
  const [rooms, setRooms] = useState<RoomDraft[]>([newRoom()]);
  const [target, setTarget] = useState<{ room: string; spot: Spot } | null>(null);
  const [b, setB] = useState({ name: "", company: "", phone: "", email: "", note: "" });
  const [showPrices, setShowPrices] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ link: string; blob: Blob; name: string; phone: string } | null>(null);
  const [sheets, setSheets] = useState<Sheet[]>([]);

  const load = useCallback(async () => {
    const [{ data }, { data: sup }, { data: sh }] = await Promise.all([
      supabase.from("products").select("*").eq("store_id", store.id).eq("active", true).order("name").limit(2000),
      supabase.from("suppliers").select("*").order("name"),
      supabase.from("builder_sheets").select("id, token, builder_name, builder_company, builder_phone, product_ids, rooms, pdf_path, views, created_at").eq("store_id", store.id).order("created_at", { ascending: false }).limit(25),
    ]);
    setList((data ?? []) as Product[]); setSuppliers((sup ?? []) as Supplier[]); setSheets((sh ?? []) as Sheet[]);
  }, [store.id]);
  useEffect(() => { load(); }, [load]);

  const byId = useMemo(() => new Map(list.map((p) => [p.id, p])), [list]);
  const targetRoom = rooms.find((r) => r.key === target?.room) ?? null;
  const pool = useMemo(() => target && !showAll ? list.filter((p) => fitsSpot(p, target.spot)) : list, [list, target, showAll]);
  const shown = useMemo(() => applyFilters(pool, filters).slice(0, 120), [pool, filters]);
  const assigned = useMemo(() => rooms.flatMap((r) => Object.values(r.spots)).filter(Boolean) as string[], [rooms]);

  // Swatch thumbnails, signed lazily for what's on screen plus what's already picked.
  const tried = useRef(new Set<string>());
  useEffect(() => {
    const need = [...shown, ...assigned.map((id) => byId.get(id)).filter(Boolean) as Product[]].filter((p) => !tried.current.has(p.id)).slice(0, 80);
    if (!need.length) return;
    need.forEach((p) => tried.current.add(p.id));
    supabase.storage.from("swatches").createSignedUrls(need.map((p) => p.swatch_path), 3600).then(({ data }) => {
      const add: Record<string, string> = {}; data?.forEach((d, i) => { if (d.signedUrl) add[need[i].id] = d.signedUrl; });
      if (Object.keys(add).length) setThumbs((cur) => ({ ...cur, ...add }));
    });
  }, [shown, assigned, byId]);

  const patch = (key: string, fn: (r: RoomDraft) => RoomDraft) => setRooms((cur) => cur.map((r) => r.key === key ? fn(r) : r));
  function pick(p: Product) {
    if (!target) { ctx.toast("Tap a spot in a room first (Floor, Backsplash…)."); return; }
    patch(target.room, (r) => ({ ...r, spots: { ...r.spots, [target.spot]: p.id }, error: null }));
    // Jump to the next empty spot in the same room.
    const r = rooms.find((x) => x.key === target.room)!;
    const next = roomType(r.room_type).spots.find((s) => s !== target.spot && !r.spots[s]);
    setTarget(next ? { room: r.key, spot: next } : null);
  }
  function setType(r: RoomDraft, type: string) {
    const keep = Object.fromEntries(Object.entries(r.spots).filter(([s]) => roomType(type).spots.includes(s as Spot)));
    const autoLabel = ROOM_TYPES.some((t) => t.label === r.label) || !r.label;
    patch(r.key, (x) => ({ ...x, room_type: type, spots: keep, label: autoLabel ? roomType(type).label : x.label }));
    if (target?.room === r.key && !roomType(type).spots.includes(target.spot)) setTarget(null);
  }

  async function render(r: RoomDraft, redo = false): Promise<RoomDraft["render"]> {
    const combo = comboOf(r);
    patch(r.key, (x) => ({ ...x, busy: true, error: null }));
    const { data, error } = await supabase.functions.invoke<RenderRes>("room-render", { body: { store_id: store.id, room_type: r.room_type, spots: r.spots, redo } });
    let msg: string | null = null;
    if (error) { try { msg = (await (error as { context?: Response }).context?.json())?.error ?? error.message; } catch { msg = error.message; } }
    const out = data && !msg ? { id: data.id, url: data.url, combo } : null;
    patch(r.key, (x) => ({ ...x, busy: false, error: msg, render: out ?? x.render }));
    return out;
  }

  async function create() {
    const filled = rooms.filter((r) => Object.keys(r.spots).length);
    if (!filled.length) { setErr("Add at least one product to a room."); return; }
    setErr(null); setDone(null);
    try {
      // Make any room photos that are missing or out of date (unchanged combos come back from cache, free).
      const finals: { r: RoomDraft; render: NonNullable<RoomDraft["render"]> | null }[] = [];
      for (let i = 0; i < filled.length; i++) {
        const r = filled[i];
        if (r.render && r.render.combo === comboOf(r)) { finals.push({ r, render: r.render }); continue; }
        setBusy(`Making room photo ${i + 1} of ${filled.length}…`);
        finals.push({ r, render: (await render(r)) ?? null });
      }
      setBusy("Fetching images…");
      const sheetRooms: SheetRoom[] = await Promise.all(finals.map(async ({ r, render: rr }) => ({
        label: r.label || roomType(r.room_type).label,
        photoUrl: rr?.url ?? null,
        products: await Promise.all(roomType(r.room_type).spots.filter((s) => r.spots[s] && byId.get(r.spots[s]!)).map(async (s) => {
          const p = byId.get(r.spots[s]!)!;
          return { spot: SPOT_LABEL[s], name: p.name, sku: p.sku, type: p.type, length_in: p.length_in, width_in: p.width_in, finish: p.finish, collection: p.collection, colour_family: p.colour_family, price_per_sqft: p.price_per_sqft, swatchUrl: await signedUrl("swatches", p.swatch_path) };
        })),
      })));
      const logoUrl = store.logo_path ? await signedUrl("brand", store.logo_path) : null;
      setBusy("Laying out the PDF…");
      const bytes = await buildBuilderPdf({ store, builder: { name: b.name.trim(), company: b.company.trim() }, note: b.note, showPrices, rooms: sheetRooms, logoUrl });
      const blob = new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], { type: "application/pdf" });
      setBusy("Saving…");
      const id = crypto.randomUUID(); const token = newToken(); const path = `${store.id}/builders/${id}.pdf`;
      const up = await supabase.storage.from("proposals").upload(path, blob, { contentType: "application/pdf" });
      if (up.error) throw new Error(up.error.message);
      const { error } = await supabase.from("builder_sheets").insert({
        id, token, store_id: store.id, builder_name: b.name.trim() || null, builder_company: b.company.trim() || null, builder_phone: b.phone.trim() || null, builder_email: b.email.trim() || null,
        note: b.note.trim() || null, show_prices: showPrices, pdf_path: path, created_by: ctx.session.user.id,
        product_ids: Array.from(new Set(filled.flatMap((r) => Object.values(r.spots)))),
        rooms: finals.map(({ r, render: rr }) => ({ label: r.label || roomType(r.room_type).label, room_type: r.room_type, spots: r.spots, render_id: rr?.id ?? null })),
      });
      if (error) throw new Error(error.message);
      const who = b.company.trim() || b.name.trim();
      setDone({ link: sheetLink(token), blob, name: `${safe(store.name)}-finishes${who ? "-" + safe(who) : ""}.pdf`, phone: b.phone.trim() });
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
  const smsBody = (link: string) => `Hi${b.name ? " " + b.name.split(" ")[0] : ""}, here are the finishes we talked about, with photos and specs: ${link} — ${store.name}${store.phone ? " " + store.phone : ""}`;
  async function redownload(s: Sheet) {
    if (!s.pdf_path) return; const u = await signedUrl("proposals", s.pdf_path); if (!u) return;
    download(await (await fetch(u)).blob(), `${safe(store.name)}-finishes${s.builder_company || s.builder_name ? "-" + safe(s.builder_company || s.builder_name || "") : ""}.pdf`);
  }
  const reset = () => { setDone(null); setRooms([newRoom()]); setTarget(null); setB({ name: "", company: "", phone: "", email: "", note: "" }); };

  return (
    <div className="two">
      <div className="card">
        <h2>Send to a builder</h2>
        <div className="grid2">
          <label className="f">Name<input type="text" value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} /></label>
          <label className="f">Company<input type="text" value={b.company} onChange={(e) => setB({ ...b, company: e.target.value })} /></label>
          <label className="f">Phone<input type="tel" value={b.phone} onChange={(e) => setB({ ...b, phone: e.target.value })} /></label>
          <label className="f">Email<input type="email" value={b.email} onChange={(e) => setB({ ...b, email: e.target.value })} /></label>
        </div>
        <label className="f">Note on the sheet (optional)<textarea value={b.note} placeholder="e.g. Finishes for the 12-unit build on 118 Ave. Contractor pricing on request." onChange={(e) => setB({ ...b, note: e.target.value })} /></label>
        <label className="row small"><input type="checkbox" checked={showPrices} onChange={(e) => setShowPrices(e.target.checked)} /> Show $/sq ft (only products with a price set)</label>

        {rooms.map((r, ri) => {
          const stale = r.render && r.render.combo !== comboOf(r);
          const any = Object.keys(r.spots).length > 0;
          return (
            <div key={r.key} className="card" style={{ gap: 10 }}>
              <div className="row">
                <input type="text" className="grow" value={r.label} aria-label="Room name" onChange={(e) => patch(r.key, (x) => ({ ...x, label: e.target.value }))} />
                <select value={r.room_type} onChange={(e) => setType(r, e.target.value)} style={{ width: "auto" }} aria-label="Room type">
                  {ROOM_TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </select>
                {rooms.length > 1 && <button className="sm ghost" onClick={() => { setRooms((cur) => cur.filter((x) => x.key !== r.key)); if (target?.room === r.key) setTarget(null); }} aria-label={`Remove room ${ri + 1}`}>Remove</button>}
              </div>
              {roomType(r.room_type).spots.map((s) => {
                const p = r.spots[s] ? byId.get(r.spots[s]!) : null;
                const on = target?.room === r.key && target.spot === s;
                return (
                  <div key={s} className="row" style={{ padding: 6, borderRadius: 10, outline: on ? "2px solid var(--color-primary)" : "1px solid var(--color-contrast-lower)" }}>
                    <span className="small muted" style={{ width: 92 }}>{SPOT_LABEL[s]}</span>
                    {p ? <>
                      {thumbs[p.id] ? <img src={thumbs[p.id]} alt="" style={{ width: 36, height: 36, objectFit: "cover", borderRadius: 6 }} /> : <span style={{ width: 36 }} />}
                      <span className="grow small"><strong>{p.name}</strong></span>
                      <button className="sm ghost" onClick={() => setTarget({ room: r.key, spot: s })}>Change</button>
                      <button className="sm ghost" aria-label={`Clear ${SPOT_LABEL[s]}`} onClick={() => patch(r.key, (x) => { const sp = { ...x.spots }; delete sp[s]; return { ...x, spots: sp }; })}>×</button>
                    </> : <button className={"sm grow" + (on ? " on" : " ghost")} style={{ textAlign: "left" }} onClick={() => setTarget(on ? null : { room: r.key, spot: s })}>{on ? "Pick a product on the right →" : "+ Pick product"}</button>}
                  </div>
                );
              })}
              {r.render?.url && (
                <div style={{ position: "relative" }}>
                  <img src={r.render.url} alt={`${r.label} preview`} style={{ width: "100%", borderRadius: 12, display: "block", opacity: stale ? 0.45 : 1 }} />
                  {stale && <span className="pill" style={{ position: "absolute", top: 8, left: 8 }}>Products changed — make a new photo</span>}
                </div>
              )}
              {any && (
                <div className="row">
                  <button className="sm" disabled={r.busy || !!busy} onClick={() => render(r, !!r.render && !stale)}>
                    {r.busy ? <><span className="spinner" /> Making photo… (~30 s)</> : !r.render || stale ? "Make photo" : "Redo photo"}
                  </button>
                  {r.error && <span className="warn small">{r.error}</span>}
                </div>
              )}
            </div>
          );
        })}
        <button className="ghost" onClick={() => { const n = newRoom(rooms.some((r) => r.room_type === "kitchen") ? "bathroom" : "kitchen"); setRooms((cur) => [...cur, n]); setTarget({ room: n.key, spot: "floor" }); }}>+ Add room</button>

        <button className="primary big" disabled={!!busy || !rooms.some((r) => Object.keys(r.spots).length)} onClick={create}>{busy ? <><span className="spinner" /> {busy}</> : "Create sheet"}</button>
        {err && <p className="warn small">{err}</p>}
        {done && (
          <div className="card">
            <strong>Ready to send</strong>
            <input type="text" readOnly value={done.link} onFocus={(e) => e.currentTarget.select()} />
            <div className="row">
              <button className="primary" onClick={() => copy(done.link)}>Copy link</button>
              {done.phone && <a href={`sms:${done.phone}?&body=${encodeURIComponent(smsBody(done.link))}`}><button>Text it</button></a>}
              <button onClick={() => download(done.blob, done.name)}>Download PDF</button>
              <button className="sm ghost" onClick={reset}>New sheet</button>
            </div>
            <p className="small muted">The link doesn't expire. It shows each room photo, the products in it with specs, and a PDF download.</p>
          </div>
        )}

        <h2 style={{ marginTop: 8 }}>Sent to builders</h2>
        {!sheets.length && <p className="muted small">None yet.</p>}
        {sheets.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th>Builder</th><th>Rooms</th><th>Opened</th><th></th></tr></thead>
            <tbody>
              {sheets.map((s) => (
                <tr key={s.id}>
                  <td>{s.builder_company || s.builder_name || s.builder_phone || "—"}<div className="small muted">{new Date(s.created_at).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}</div></td>
                  <td>{s.rooms?.length || s.product_ids.length}</td>
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
        <h2>{target && targetRoom ? `${SPOT_LABEL[target.spot]} · ${targetRoom.label}` : "Products"}</h2>
        {!target && <p className="small muted">Tap a spot in a room (Floor, Backsplash…) and pick what goes there.</p>}
        {target && <label className="row small"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show everything (not just products tagged for {SPOT_LABEL[target.spot].toLowerCase()})</label>}
        <ProductFilter list={pool} suppliers={suppliers} value={filters} onChange={setFilters} />
        <div className="catalog" style={{ maxHeight: 640 }}>
          {shown.map((p) => (
            <button key={p.id} type="button" className={"sku" + (target && targetRoom?.spots[target.spot] === p.id ? " on" : "")} onClick={() => pick(p)} title={p.name}>
              {thumbs[p.id] ? <img src={thumbs[p.id]} alt="" loading="lazy" /> : <img alt="" />}
              <span className="nm">{p.name}</span>
              <span className="dm">{p.type}{p.length_in && p.width_in ? ` · ${p.length_in}×${p.width_in}` : ""}</span>
            </button>
          ))}
        </div>
        {applyFilters(pool, filters).length > shown.length && <p className="small muted">Showing the first {shown.length}. Search or filter to narrow it down.</p>}
        {target && !shown.length && <p className="small muted">Nothing tagged for this spot. Tick "Show everything", or tag products in Products → Edit.</p>}
      </div>
    </div>
  );
}
