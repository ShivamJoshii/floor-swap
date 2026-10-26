import { useCallback, useEffect, useState } from "react";
import { supabase, money, type Pack } from "../lib/supabase";
import type { Ctx } from "../App";

type StoreRow = { id: string; name: string; city: string | null; created_at: string; balance: number; members: number; renders: number; last_render: string | null; plan_id?: string | null; plan_status?: string | null };
type Plan = { id: string; name: string; monthly_cents: number };

export default function Admin({ ctx }: { ctx: Ctx }) {
  const [stores, setStores] = useState<StoreRow[]>([]);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [target, setTarget] = useState<StoreRow | null>(null);
  const [packId, setPackId] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("purchase");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [ns, setNs] = useState({ name: "", city: "Edmonton", email: "", plan: "", credits: "10" });
  const [nsBusy, setNsBusy] = useState(false);
  const [nsMsg, setNsMsg] = useState<string | null>(null);

  async function createStore(e: React.FormEvent) {
    e.preventDefault(); setNsBusy(true); setNsMsg(null);
    const { data, error } = await supabase.rpc("admin_create_store", { p_name: ns.name, p_city: ns.city, p_owner_email: ns.email, p_plan: ns.plan || null, p_credits: parseInt(ns.credits || "0", 10) });
    setNsBusy(false);
    if (error) { setNsMsg(error.message); return; }
    setNsMsg(`Created. ${ns.email ? `Tell them to sign up with ${ns.email} — they land in it as owner.` : "No owner email: you're the only member for now."} ${ns.plan ? "Plan set manually; no card on file." : "14-day trial, watermarked."}`);
    ctx.toast(`${ns.name} created.`); setNs({ name: "", city: "Edmonton", email: "", plan: "", credits: "10" }); load(); ctx.reloadStore(); void data;
  }

  const load = useCallback(async () => {
    const [{ data: s }, { data: p }, { data: pl }, { data: st }] = await Promise.all([supabase.rpc("admin_stores"), supabase.from("credit_packs").select("*").order("sort"), supabase.from("plans").select("id, name, monthly_cents").order("sort"), supabase.from("stores").select("id, plan_id, plan_status")]);
    const planMap = new Map(((st ?? []) as { id: string; plan_id: string | null; plan_status: string | null }[]).map((x) => [x.id, x]));
    setStores(((s ?? []) as StoreRow[]).map((r) => ({ ...r, plan_id: planMap.get(r.id)?.plan_id ?? null, plan_status: planMap.get(r.id)?.plan_status ?? null }))); setPacks((p ?? []) as Pack[]); setPlans((pl ?? []) as Plan[]);
  }, []);
  useEffect(() => { load(); }, [load]);

  const pack = packs.find((p) => p.id === packId) ?? null;
  const credits = pack ? pack.credits : parseInt(amount || "0", 10);

  async function grant(e: React.FormEvent) {
    e.preventDefault(); if (!target || !(credits > 0)) return;
    setBusy(true); setErr(null);
    const { error } = await supabase.rpc("grant_credits", { p_store: target.id, p_amount: credits, p_reason: reason, p_pack: pack?.id ?? null, p_note: note || (pack ? `${pack.name} pack` : null) });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    ctx.toast(`+${credits} credits → ${target.name}`); setTarget(null); setPackId(""); setAmount(""); setNote(""); load(); ctx.refreshBalance();
  }


  return (
    <div className="two">
      <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
      <form className="card" onSubmit={createStore}>
        <h2>New store (demo / in-person signup)</h2>
        <div className="grid2">
          <label className="f">Store name<input type="text" required value={ns.name} onChange={(e) => setNs({ ...ns, name: e.target.value })} /></label>
          <label className="f">City<input type="text" value={ns.city} onChange={(e) => setNs({ ...ns, city: e.target.value })} /></label>
        </div>
        <label className="f">Owner email (they sign up with this)<input type="email" value={ns.email} onChange={(e) => setNs({ ...ns, email: e.target.value })} placeholder="owner@store.com" /></label>
        <div className="grid2">
          <label className="f">Plan<select value={ns.plan} onChange={(e) => setNs({ ...ns, plan: e.target.value })}><option value="">Free trial (14 days, watermarked)</option>{plans.map((p) => <option key={p.id} value={p.id}>{p.name} · {money(p.monthly_cents)}/mo (set manually, bill outside Stripe)</option>)}</select></label>
          <label className="f">Starter renders<input type="number" min="0" value={ns.credits} onChange={(e) => setNs({ ...ns, credits: e.target.value })} /></label>
        </div>
        <button className="primary" disabled={nsBusy}>{nsBusy ? <span className="spinner" /> : "Create store"}</button>
        {nsMsg && <p className="small">{nsMsg}</p>}
      </form>
      <form className="card" onSubmit={grant}>
        <h2>Add credits</h2>
        <label className="f">Store<select value={target?.id ?? ""} onChange={(e) => setTarget(stores.find((s) => s.id === e.target.value) ?? null)} required>
          <option value="">Pick a store</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.balance} left</option>)}
        </select></label>
        <label className="f">Pack<select value={packId} onChange={(e) => setPackId(e.target.value)}>
          <option value="">Custom amount</option>{packs.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.credits} credits · {money(p.price_cents, p.currency)}</option>)}
        </select></label>
        {!pack && <label className="f">Credits<input type="number" min="1" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>}
        <div className="grid2">
          <label className="f">Reason<select value={reason} onChange={(e) => setReason(e.target.value)}><option value="purchase">Purchase</option><option value="adjustment">Adjustment</option><option value="trial">Trial</option></select></label>
          <label className="f">Note<input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e-transfer 21 Oct" /></label>
        </div>
        <button className="primary" disabled={busy || !target || !(credits > 0)}>{busy ? <span className="spinner" /> : `Add ${credits > 0 ? credits : ""} credits`}</button>
        {err && <p className="warn small">{err}</p>}
        <p className="small muted">Packs and prices are rows in <span className="mono">credit_packs</span>; plans in <span className="mono">plans</span>; model settings in <span className="mono">app_settings</span>.</p>
      </form>
      </div>

      <div className="card">
        <h2>Stores</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Store</th><th>Plan</th><th className="num">Top-ups</th><th className="num">Members</th><th className="num">Renders</th><th>Last render</th><th>Since</th></tr></thead>
          <tbody>
            {stores.map((s) => (
              <tr key={s.id}>
                <td><strong>{s.name}</strong>{s.city && <span className="muted"> · {s.city}</span>}</td>
                <td><span className={"status " + (s.plan_status === "active" ? "done" : s.plan_status === "past_due" || s.plan_status === "canceled" ? "failed" : "")}>{s.plan_status === "active" ? (plans.find((p) => p.id === s.plan_id)?.name ?? s.plan_id) : s.plan_status ?? "trial"}</span></td>
                <td className="num">{s.balance}</td>
                <td className="num">{s.members}</td>
                <td className="num">{s.renders}</td>
                <td className="muted">{s.last_render ? new Date(s.last_render).toLocaleDateString("en-CA") : "—"}</td>
                <td className="muted">{new Date(s.created_at).toLocaleDateString("en-CA")}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      </div>
    </div>
  );
}
