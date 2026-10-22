import { useCallback, useEffect, useState } from "react";
import { supabase, signedUrl } from "../lib/supabase";
import { buildProposalPdf } from "../lib/pdf";
import type { Ctx } from "../App";

type Row = { id: string; lead_name: string | null; lead_phone: string | null; items: { product: { name: string } }[]; pdf_path: string | null; created_at: string };
const WEEK = 7 * 24 * 3600;

export default function Proposal({ ctx }: { ctx: Ctx }) {
  const store = ctx.membership.stores;
  const items = ctx.proposal;
  const [lead, setLead] = useState({ name: "", phone: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ blob: Blob; link: string; name: string } | null>(null);
  const [recent, setRecent] = useState<Row[]>([]);

  const loadRecent = useCallback(async () => {
    const { data } = await supabase.from("proposals").select("id, lead_name, lead_phone, items, pdf_path, created_at").eq("store_id", store.id).order("created_at", { ascending: false }).limit(15);
    setRecent((data ?? []) as Row[]);
  }, [store.id]);
  useEffect(() => { loadRecent(); }, [loadRecent]);

  useEffect(() => {
    if (!items.length || lead.name || lead.phone) return;
    supabase.from("renders").select("lead_name, lead_phone").eq("id", items[0].render_id).maybeSingle().then(({ data }) => {
      if (data && (data.lead_name || data.lead_phone)) setLead({ name: data.lead_name ?? "", phone: data.lead_phone ?? "" });
    });
  }, [items, lead.name, lead.phone]);

  const remove = (path: string) => ctx.setProposal((cur) => cur.filter((it) => it.output_path !== path));
  const move = (i: number, dir: -1 | 1) => ctx.setProposal((cur) => { const n = [...cur]; const j = i + dir; if (j < 0 || j >= n.length) return cur; [n[i], n[j]] = [n[j], n[i]]; return n; });

  async function build() {
    if (!items.length) return;
    setErr(null); setDone(null); setBusy("Fetching images…");
    try {
      // Fresh signed URLs: the ones in memory may be close to expiry.
      const fresh = await Promise.all(items.map(async (it) => ({
        ...it,
        url: (await signedUrl("renders", it.output_path)) ?? it.url,
        swatchUrl: await signedUrl("swatches", it.product.swatch_path),
      })));
      const beforeUrl = await signedUrl("rooms", items[0].room_path);
      const logoUrl = store.logo_path ? await signedUrl("brand", store.logo_path) : null;
      setBusy("Laying out the PDF…");
      const bytes = await buildProposalPdf({ store, lead, beforeUrl, items: fresh, logoUrl });
      const blob = new Blob([new Uint8Array(bytes).buffer as ArrayBuffer], { type: "application/pdf" });
      setBusy("Saving…");
      const id = crypto.randomUUID(); const path = `${store.id}/${id}.pdf`;
      const up = await supabase.storage.from("proposals").upload(path, blob, { contentType: "application/pdf" });
      if (up.error) throw new Error(up.error.message);
      const { error } = await supabase.from("proposals").insert({
        id, store_id: store.id, lead_name: lead.name || null, lead_phone: lead.phone || null, room_path: items[0].room_path, pdf_path: path, created_by: ctx.session.user.id,
        items: fresh.map((it) => ({ render_id: it.render_id, output_path: it.output_path, product: { id: it.product.id, name: it.product.name } })),
      });
      if (error) throw new Error(error.message);
      const link = (await signedUrl("proposals", path, WEEK)) ?? "";
      const name = `${safe(store.name)}-options${lead.name ? "-" + safe(lead.name) : ""}.pdf`;
      setDone({ blob, link, name });
      ctx.toast("Proposal ready."); loadRecent();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }
  const safe = (s: string) => s.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 40) || "proposal";
  function download(blob: Blob, name: string) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  async function copyLink(link: string) {
    try { await navigator.clipboard.writeText(link); ctx.toast("Link copied — valid for 7 days."); } catch { ctx.toast("Copy blocked; select the link text instead."); }
  }
  async function relink(r: Row) {
    if (!r.pdf_path) return;
    const link = await signedUrl("proposals", r.pdf_path, WEEK); if (!link) { ctx.toast("Could not create a link."); return; }
    await copyLink(link);
  }
  async function redownload(r: Row) {
    if (!r.pdf_path) return;
    const u = await signedUrl("proposals", r.pdf_path); if (!u) return;
    const b = await (await fetch(u)).blob(); download(b, `${safe(store.name)}-options${r.lead_name ? "-" + safe(r.lead_name) : ""}.pdf`);
  }

  return (
    <div className="two">
      <div className="card">
        <h2>Proposal · {items.length} option{items.length === 1 ? "" : "s"}</h2>
        {!items.length && <p className="muted">Nothing picked yet. On Generate, hit <strong>+ Proposal</strong> on any option you want in the PDF — from one product or several.</p>}
        {items.map((it, i) => (
          <div key={it.output_path} className="row" style={{ borderBottom: "1px solid var(--line)", paddingBottom: 8 }}>
            <img className="thumb" src={it.url} alt="" style={{ width: 84, height: 63 }} />
            <div className="grow"><strong>{it.product.name}</strong><div className="small muted">Option {i + 1}</div></div>
            <button className="sm ghost" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
            <button className="sm ghost" onClick={() => move(i, 1)} disabled={i === items.length - 1} aria-label="Move down">↓</button>
            <button className="sm ghost" onClick={() => remove(it.output_path)}>Remove</button>
          </div>
        ))}
        <div className="grid2">
          <label className="f">Customer name<input type="text" value={lead.name} onChange={(e) => setLead({ ...lead, name: e.target.value })} /></label>
          <label className="f">Customer phone<input type="tel" value={lead.phone} onChange={(e) => setLead({ ...lead, phone: e.target.value })} /></label>
        </div>
        <button className="primary big" disabled={!items.length || !!busy} onClick={build}>{busy ? <><span className="spinner" /> {busy}</> : "Build PDF"}</button>
        {err && <p className="warn small">{err}</p>}
        {done && (
          <div className="card" style={{ background: "var(--bg)" }}>
            <strong>{done.name}</strong>
            <div className="row">
              <button className="primary" onClick={() => download(done.blob, done.name)}>Download PDF</button>
              <button onClick={() => copyLink(done.link)}>Copy 7-day link</button>
              <button className="sm ghost" onClick={() => { ctx.setProposal(() => []); setDone(null); }}>Start a new one</button>
            </div>
            <p className="small muted">Text the link, or attach the file. The link stops working after 7 days; make a new one here any time.</p>
          </div>
        )}
        <p className="small muted">Branding (name, phone, address, colour, logo) comes from <button className="sm ghost" style={{ padding: "0 4px" }} onClick={() => ctx.goTo("team")}>Store &amp; team</button>.</p>
      </div>

      <div className="card">
        <h2>Sent proposals</h2>
        {!recent.length && <p className="muted">None yet.</p>}
        {recent.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th>Customer</th><th>Options</th><th>When</th><th></th></tr></thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.id}>
                  <td>{r.lead_name || r.lead_phone || "—"}</td>
                  <td className="small">{(r.items ?? []).map((it) => it.product?.name).filter(Boolean).join(", ")}</td>
                  <td className="muted">{new Date(r.created_at).toLocaleString("en-CA", { dateStyle: "short", timeStyle: "short" })}</td>
                  <td className="row" style={{ justifyContent: "flex-end" }}>
                    <button className="sm" onClick={() => relink(r)}>Copy link</button>
                    <button className="sm ghost" onClick={() => redownload(r)}>PDF</button>
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
