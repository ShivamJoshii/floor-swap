import { useCallback, useEffect, useState } from "react";
import { supabase, money, SALES_CONTACT, type Pack } from "../lib/supabase";
import type { Ctx } from "../App";

type Plan = { id: string; name: string; monthly_cents: number; annual_cents: number; renders_per_month: number; max_users: number | null; max_locations: number; features: string[]; sort: number };
type Usage = { plan_id: string | null; plan_status: string; renders_per_month: number; used_this_period: number; period_end: string | null; credits: number | null; trial_ends_at: string | null; watermark: boolean };
type Row = { id: number; delta: number; reason: string; note: string | null; pack_id: string | null; created_at: string };
type Img = { id: string; created_at: string; kind: "render" | "showcase"; product_name: string | null; images: number; plan_images: number; credit_images: number; status: string; who: string | null; thumb_path: string | null };
const PAGE = 25;

export default function Credits({ ctx }: { ctx: Ctx }) {
  const store = ctx.membership.stores;
  const isOwner = ctx.membership.role === "owner";
  const [plans, setPlans] = useState<Plan[]>([]);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [imgs, setImgs] = useState<Img[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [more, setMore] = useState(false);
  const [interval, setInterval] = useState<"month" | "year">("month");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: p }, { data: k }, { data: u }, { data: l }] = await Promise.all([
      supabase.from("plans").select("*").eq("active", true).order("sort"),
      supabase.from("credit_packs").select("*").eq("active", true).order("sort"),
      supabase.rpc("store_usage", { p_store: store.id }),
      supabase.from("credit_ledger").select("id, delta, reason, note, pack_id, created_at").eq("store_id", store.id).gt("delta", 0).neq("reason", "refund").order("created_at", { ascending: false }).limit(30),
    ]);
    setPlans((p ?? []) as Plan[]); setPacks((k ?? []) as Pack[]); setRows((l ?? []) as Row[]);
    const row = Array.isArray(u) ? u[0] : u; setUsage((row ?? null) as Usage | null);
  }, [store.id]);
  useEffect(() => { load(); ctx.refreshBalance(); }, [load, ctx]);

  // Every image this store has generated, newest first.
  const loadImages = useCallback(async (before?: string) => {
    const { data } = await supabase.rpc("store_image_history", { p_store: store.id, p_limit: PAGE, p_before: before ?? null });
    const page = (data ?? []) as Img[];
    setMore(page.length === PAGE);
    setImgs((cur) => before ? [...cur, ...page] : page);
    const paths = page.map((r) => r.thumb_path).filter((p): p is string => !!p);
    if (paths.length) {
      const { data: urls } = await supabase.storage.from("renders").createSignedUrls(paths, 3600);
      const add: Record<string, string> = {};
      urls?.forEach((u, i) => { if (u.signedUrl) add[paths[i]] = u.signedUrl; });
      setThumbs((cur) => ({ ...cur, ...add }));
    }
  }, [store.id]);
  useEffect(() => { loadImages(); }, [loadImages]);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("billing");
    if (q === "success") { ctx.toast("Payment received. Updating your plan…"); window.history.replaceState({}, "", "/"); setTimeout(() => { load(); ctx.reloadStore(); ctx.refreshBalance(); }, 2500); }
    if (q === "cancel") { ctx.toast("Checkout cancelled."); window.history.replaceState({}, "", "/"); }
  }, [ctx, load]);

  async function go(fn: "billing-checkout" | "billing-portal", body: Record<string, unknown>, label: string) {
    setErr(null); setBusy(label);
    const { data, error } = await supabase.functions.invoke(fn, { body: { store_id: store.id, ...body } });
    setBusy(null);
    if (error) { let msg = error.message; try { const j = await (error as { context?: Response }).context?.json(); if (j?.error) msg = j.error; } catch { /* keep */ } setErr(msg); return; }
    if (data?.url) window.location.href = data.url; else setErr(data?.error ?? "Could not open checkout.");
  }

  const active = usage?.plan_status === "active" && usage.plan_id;
  const trial = usage?.plan_status === "trial";
  const used = usage?.used_this_period ?? 0, allowance = usage?.renders_per_month ?? 0;
  const pct = allowance ? Math.min(100, Math.round(100 * used / allowance)) : 0;
  const fmt = (d: string | null) => d ? new Date(d).toLocaleDateString("en-CA", { month: "short", day: "numeric" }) : "";
  const perMonth = (p: Plan) => interval === "year" ? Math.round(p.annual_cents / 12) : p.monthly_cents;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2>Your plan</h2>
          {active && isOwner && <button className="sm" disabled={!!busy} onClick={() => go("billing-portal", {}, "portal")}>{busy === "portal" ? <span className="spinner" /> : "Manage billing"}</button>}
        </div>
        {trial && (
          <p><strong>Free trial</strong> · {usage?.credits ?? 0} images left{usage?.trial_ends_at ? ` · ends ${fmt(usage.trial_ends_at)}` : ""}. Images are watermarked until you pick a plan.</p>
        )}
        {active && (
          <>
            <p><strong>{plans.find((p) => p.id === usage?.plan_id)?.name ?? usage?.plan_id}</strong> · {used} of {allowance} images used this month · {Math.max(0, allowance - used)} left{usage?.period_end ? ` · resets ${fmt(usage.period_end)}` : ""}</p>
            <div style={{ height: 8, background: "var(--line)", borderRadius: 4, overflow: "hidden" }}><div style={{ width: `${pct}%`, height: "100%", background: pct >= 90 ? "var(--warn)" : "var(--accent)" }} /></div>
            {(usage?.credits ?? 0) > 0 && <p className="small muted">Plus {usage?.credits} top-up images in reserve (used after the monthly allowance).</p>}
            <p className="small muted">Every image counts as one: each version of a room render, and each product room photo. Images that fail aren't counted.</p>
            {pct >= 90 && <p className="small warn">Close to the limit. Add a top-up below, or email <span className="mono">{SALES_CONTACT}</span> about a bigger plan.</p>}
          </>
        )}
        {usage?.plan_status === "past_due" && <p className="warn">Last payment failed. Update your card under Manage billing to keep generating.</p>}
        {usage?.plan_status === "canceled" && <p className="warn">Plan cancelled. Pick a plan below to continue.</p>}
        {!isOwner && <p className="small muted">Only the store owner can change the plan.</p>}
      </div>

      {(!active || usage?.plan_status === "canceled") && (
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <h2>Pick a plan</h2>
            <div className="seg"><button className={interval === "month" ? "on" : ""} onClick={() => setInterval("month")}>Monthly</button><button className={interval === "year" ? "on" : ""} onClick={() => setInterval("year")}>Annual · 2 months free</button></div>
          </div>
          <div className="packs">
            {plans.map((p, i) => (
              <div key={p.id} className={"pack" + (i === 1 ? " best" : "")}>
                {i === 1 && <span className="pill small">Most stores</span>}
                <strong>{p.name}</strong>
                <div className="price">{money(perMonth(p))}<span className="small muted" style={{ fontFamily: "var(--font-ui)", fontWeight: 400 }}>/mo</span></div>
                {interval === "year" && <div className="small muted">{money(p.annual_cents)} billed yearly</div>}
                <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{(p.features ?? []).map((f) => <li key={f}>{f}</li>)}</ul>
                <button className={i === 1 ? "primary" : ""} disabled={!isOwner || !!busy} onClick={() => go("billing-checkout", { plan_id: p.id, interval }, p.id)}>{busy === p.id ? <span className="spinner" /> : `Start ${p.name}`}</button>
              </div>
            ))}
          </div>
          <p className="small muted">All plans: proposal PDFs, supplier catalog, colour & room tags, unlimited products. 30-day money-back on your first month. Cancel any time.</p>
        </div>
      )}

      <div className="card">
        <h2>Top-up images</h2>
        <p className="small muted">One-time, never expire. Used after your monthly allowance{trial ? ", no watermark" : ""}.</p>
        <div className="packs">
          {packs.map((k) => (
            <div key={k.id} className="pack">
              <strong>{k.name}</strong>
              <div className="price">{money(k.price_cents, k.currency)}</div>
              <div className="small muted">{money(k.price_cents / k.credits, k.currency)} per image</div>
              <button disabled={!isOwner || !!busy} onClick={() => go("billing-checkout", { pack_id: k.id }, k.id)}>{busy === k.id ? <span className="spinner" /> : "Buy"}</button>
            </div>
          ))}
        </div>
        {err && <p className="warn small">{err}</p>}
      </div>

      <div className="card">
        <h2>Images generated</h2>
        {!imgs.length && <p className="muted">Nothing generated yet.</p>}
        {imgs.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th></th><th>When</th><th>What</th><th>By</th><th className="num">Images</th><th>Counted against</th></tr></thead>
            <tbody>
              {imgs.map((r) => (
                <tr key={r.id}>
                  <td style={{ width: 52 }}>{r.thumb_path && thumbs[r.thumb_path] ? <img src={thumbs[r.thumb_path]} alt="" loading="lazy" style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 4, display: "block" }} /> : null}</td>
                  <td className="muted">{new Date(r.created_at).toLocaleString("en-CA", { dateStyle: "short", timeStyle: "short" })}</td>
                  <td>{r.kind === "render" ? "Room render" : "Product room photo"}{r.product_name ? <span className="muted"> · {r.product_name}</span> : ""}</td>
                  <td className="small muted">{r.who ?? "—"}</td>
                  <td className="num">{r.images}</td>
                  <td className="small muted">{r.status === "failed" ? "failed · not counted"
                    : [r.plan_images ? `${r.plan_images} plan` : "", r.credit_images ? `${r.credit_images} top-up` : ""].filter(Boolean).join(" + ") || "not counted"}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        {more && <button className="sm" onClick={() => loadImages(imgs[imgs.length - 1]?.created_at)}>Show older</button>}
      </div>

      <div className="card">
        <h2>Top-ups and trial images</h2>
        {!rows.length && <p className="muted">None yet.</p>}
        {rows.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th>When</th><th>What</th><th className="num">Images</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="muted">{new Date(r.created_at).toLocaleString("en-CA", { dateStyle: "short", timeStyle: "short" })}</td>
                  <td>{r.reason}{r.pack_id ? ` · ${r.pack_id}` : ""}{r.note ? <span className="muted"> — {r.note}</span> : ""}</td>
                  <td className="num" style={{ color: "var(--ok)" }}>+{r.delta}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
