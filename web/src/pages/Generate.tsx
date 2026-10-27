import { useCallback, useEffect, useRef, useState } from "react";
import { supabase, shrinkImage, signedUrl, type Product, type Render } from "../lib/supabase";
import type { Ctx } from "../App";
import type { ProposalItem } from "../lib/pdf";
import { watermark } from "../lib/image";
import ProductFilter, { applyFilters, emptyFilters, type Filters } from "../components/ProductFilter";
import type { Supplier } from "../lib/supabase";

type Output = { path: string; url: string | null };

const SURFACE_OPTS: [string, string, string][] = [
  ["floor", "Floor", "Replaces the floor"],
  ["wall", "Wall", "Replaces one wall (say which below)"],
  ["backsplash", "Backsplash", "Between counter and upper cabinets"],
  ["shower", "Shower", "Shower wall surfaces"],
  ["fireplace", "Fireplace", "Fireplace surround"],
  ["bathroom_wall", "Bathroom walls", "All bathroom wall surfaces"],
];
const FLOOR_DIRECTIONS: [string, string][] = [["auto", "Auto"], ["along", "Front to back"], ["across", "Left to right"], ["diagonal", "Diagonal"]];
const WALL_DIRECTIONS: [string, string][] = [["auto", "Auto"], ["horizontal", "Horizontal"], ["vertical", "Vertical"], ["diagonal", "Diagonal"]];
const PATTERNS: Record<string, [string, string][]> = {
  plank: [["straight", "Straight"], ["herringbone", "Herringbone"]],
  tile: [["grid", "Grid"], ["offset", "Offset"], ["stacked", "Stacked"], ["herringbone", "Herringbone"]],
  carpet: [], other: [["stacked", "Sheet"], ["grid", "Grid"]],
};

export default function Generate({ ctx }: { ctx: Ctx }) {
  const store = ctx.membership.store_id;
  const [products, setProducts] = useState<Product[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [filters, setFilters] = useState<Filters>({ ...emptyFilters, surface: "floor" });
  const [showAll, setShowAll] = useState(false);
  const [swatchUrls, setSwatchUrls] = useState<Record<string, string>>({});
  const [productId, setProductId] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [direction, setDirection] = useState("auto");
  const [pattern, setPattern] = useState("");
  const [surface, setSurface] = useState("floor");
  const [area, setArea] = useState("");
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
    const [{ data }, { data: sup }] = await Promise.all([
      supabase.from("products").select("*").eq("store_id", store).eq("active", true).order("name").limit(2000),
      supabase.from("suppliers").select("*").order("name"),
    ]);
    const list = (data ?? []) as Product[];
    setProducts(list); setSuppliers((sup ?? []) as Supplier[]);
    setProductId((cur) => cur && list.some((p) => p.id === cur) ? cur : (list[0]?.id ?? null));
  }, [store]);
  const visible = applyFilters(products, filters);
  const shown = showAll ? visible : visible.slice(0, 60);
  useEffect(() => {
    const need = shown.filter((p) => !swatchUrls[p.id]); if (!need.length) return;
    let cancelled = false;
    supabase.storage.from("swatches").createSignedUrls(need.map((p) => p.swatch_path), 3600).then(({ data: urls }) => {
      if (cancelled) return;
      setSwatchUrls((cur) => { const m = { ...cur }; (urls ?? []).forEach((u, i) => { if (u.signedUrl && need[i]) m[need[i].id] = u.signedUrl; }); return m; });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown.map((p) => p.id).join(",")]);

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
        body: { store_id: store, product_id: product.id, room_path: roomPath, options: { direction, pattern, surface, area: surface === "wall" ? area : "" }, lead_name: lead.name || null, lead_phone: lead.phone || null, num_images: nOpts },
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

  async function fetchBlob(url: string) { const r = await fetch(url); if (!r.ok) throw new Error("Could not fetch image."); const b = await r.blob(); return ctx.watermark ? await watermark(b) : b; }
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
  const noCredits = ctx.balance !== null && ctx.balance <= 0 && !ctx.hasAllowance;

  const surfaceLabel = SURFACE_OPTS.find((o) => o[0] === surface)?.[1].toLowerCase() ?? "floor";
  const ready = !!file && !!product;

  return (
    <div className="two gen">
      <div className="card">
        <div className="step"><span className="n">1</span><strong>Customer's room</strong></div>
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
          <span className="hint">{preview ? "Change photo" : <>Drop a photo<br /><span className="small">or tap to choose</span></>}</span>
          <input ref={fileInput} type="file" accept="image/*" onClick={(e) => e.stopPropagation()} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
        </div>

        <div className="step"><span className="n">2</span><strong>Where</strong></div>
        <div className="seg">
          {SURFACE_OPTS.map(([v, l]) => <button key={v} type="button" className={surface === v ? "on" : ""} onClick={() => { setSurface(v); setFilters((f) => ({ ...f, surface: v === "floor" ? "floor" : v === "backsplash" ? "backsplash" : v === "shower" ? "shower" : "wall" })); setShowAll(false); }}>{l}</button>)}
        </div>
        {surface === "wall" && <input type="text" value={area} onChange={(e) => setArea(e.target.value)} placeholder="Which wall? e.g. behind the sofa" />}

        <div className="step"><span className="n">3</span><strong>Product</strong>{product && <span className="muted small grow" style={{ textAlign: "right" }}>{product.name}</span>}</div>
        {!products.length ? <p className="small muted">No products yet. <button className="sm ghost" style={{ padding: "0 4px" }} onClick={() => ctx.goTo("products")}>Add your first</button></p> : (
          <>
            <ProductFilter list={products} suppliers={suppliers} value={filters} onChange={(f) => { setFilters(f); setShowAll(false); }} hideSurface />
            <div className="catalog">
              {shown.map((p) => (
                <div key={p.id} className={"sku" + (p.id === productId ? " on" : "")} role="button" tabIndex={0}
                  onClick={() => setProductId(p.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setProductId(p.id); }}>
                  <img src={swatchUrls[p.id]} alt="" />
                  <div className="nm">{p.name}</div>
                </div>
              ))}
            </div>
            {visible.length > shown.length && <button type="button" className="sm ghost" onClick={() => setShowAll(true)}>Show all {visible.length}</button>}
            {!visible.length && <p className="small muted">Nothing matches.</p>}
          </>
        )}

        <details className="more">
          <summary>More options</summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 12 }}>
            {product && product.type !== "carpet" && (
              <div className="grid2">
                <label className="f">Direction
                  <select value={direction} onChange={(e) => setDirection(e.target.value)}>{(surface === "floor" ? FLOOR_DIRECTIONS : WALL_DIRECTIONS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                </label>
                {(PATTERNS[product.type] ?? []).length > 0 && (
                  <label className="f">Layout
                    <select value={pattern} onChange={(e) => setPattern(e.target.value)}>{PATTERNS[product.type].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
                  </label>
                )}
              </div>
            )}
            <div className="row"><span className="small muted">Versions</span><div className="seg">{[1, 2, 3].map((n) => <button key={n} type="button" className={nOpts === n ? "on" : ""} onClick={() => setNOpts(n)}>{n}</button>)}</div></div>
            <div className="grid2">
              <label className="f">Customer name<input type="text" value={lead.name} onChange={(e) => setLead({ ...lead, name: e.target.value })} /></label>
              <label className="f">Customer phone<input type="tel" value={lead.phone} onChange={(e) => setLead({ ...lead, phone: e.target.value })} /></label>
            </div>
          </div>
        </details>

        <button className="primary big" disabled={!ready || !!busy || noCredits} onClick={generate}>
          {busy ? <><span className="spinner" /> {busy}</> : noCredits ? "No renders left" : !file ? "Add a room photo" : !product ? "Pick a product" : `Show it on the ${surfaceLabel}`}
        </button>
        {err && <p className="warn small">{err}</p>}
        {noCredits && <p className="small muted">Out of renders. <button className="sm ghost" style={{ padding: "0 4px" }} onClick={() => ctx.goTo("credits")}>See plans</button></p>}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
        {!results && !busy && (
          <div className="card empty">
            <div className="hero-steps">
              <div><span className="n">1</span>Photo of their room</div>
              <div><span className="n">2</span>Floor, wall or backsplash</div>
              <div><span className="n">3</span>Pick your product</div>
            </div>
            <p className="muted">Their room, your product, in about 20 seconds.</p>
          </div>
        )}
        {busy && !results && <div className="card empty"><span className="spinner" style={{ width: 28, height: 28 }} /><p className="muted">{busy}</p></div>}
        {results && (
          <div className="card">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <h2 style={{ textTransform: "none", letterSpacing: 0, fontSize: "var(--ts-md)", color: "var(--color-primary)" }}>{results.product.name}</h2>
              {ctx.proposal.length > 0 && <button className="sm primary" onClick={() => ctx.goTo("proposal")}>Send proposal ({ctx.proposal.length}) →</button>}
            </div>
            <div className="results big">
              {results.outputs.map((o, i) => (
                <div className="result" key={o.path}>
                  {o.url ? <img src={o.url} alt={`Version ${i + 1}`} onClick={() => setZoom(o.url)} style={{ cursor: "zoom-in" }} /> : <div className="muted" style={{ padding: 20 }}>Image unavailable</div>}
                  <div className="bar">
                    {o.url && <button className={"sm" + (inProposal(o.path) ? " on" : " primary")} onClick={() => toggleProposal(o)}>{inProposal(o.path) ? "✓ In proposal" : "Add to proposal"}</button>}
                    <span className="grow" />
                    {o.url && <button className="sm ghost" onClick={() => download(o.url!, `${safe(results.product.name)}-${i + 1}.jpg`)}>Download</button>}
                    {o.url && <button className="sm ghost" onClick={() => copy(o.url!)}>Copy</button>}
                  </div>
                </div>
              ))}
              {results.before && (
                <div className="result before">
                  <img src={results.before} alt="Before" onClick={() => setZoom(results.before)} style={{ cursor: "zoom-in" }} />
                  <div className="bar"><span className="small muted">Before</span></div>
                </div>
              )}
            </div>
            <p className="small muted">Try another product on the same photo: just pick it and hit the button again.</p>
          </div>
        )}

        {history.filter((r) => r.status === "done").length > 0 && (
          <div className="card">
            <h2>Recent</h2>
            <div className="recent">
              {history.filter((r) => r.status === "done").map((r) => (
                <button key={r.id} className="recent-item" onClick={() => openHistory(r)} title={r.product?.name ?? ""}>
                  {r.thumb ? <img src={r.thumb} alt="" /> : <div />}
                  <span className="small">{r.product?.name ?? "—"}</span>
                  <span className="small muted">{r.lead_name || new Date(r.created_at).toLocaleDateString("en-CA", { month: "short", day: "numeric" })}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {zoom && <div className="lightbox" onClick={() => setZoom(null)}><img src={zoom} alt="" /></div>}
    </div>
  );
}
