import { useCallback, useEffect, useState } from "react";
import { supabase, money, type Pack } from "../lib/supabase";
import type { Ctx } from "../App";

type StoreRow = { id: string; name: string; city: string | null; created_at: string; balance: number; members: number; renders: number; last_render: string | null };

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

  const load = useCallback(async () => {
    const [{ data: s }, { data: p }] = await Promise.all([supabase.rpc("admin_stores"), supabase.from("credit_packs").select("*").order("sort")]);
    setStores((s ?? []) as StoreRow[]); setPacks((p ?? []) as Pack[]);
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
        <p className="small muted">Packs and prices are rows in <span className="mono">credit_packs</span>; model and per-generation settings in <span className="mono">app_settings</span>.</p>
      </form>

      <div className="card">
        <h2>Stores</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>Store</th><th className="num">Credits</th><th className="num">Members</th><th className="num">Renders</th><th>Last render</th><th>Since</th></tr></thead>
          <tbody>
            {stores.map((s) => (
              <tr key={s.id}>
                <td><strong>{s.name}</strong>{s.city && <span className="muted"> · {s.city}</span>}</td>
                <td className="num" style={{ color: s.balance <= 3 ? "var(--warn)" : undefined }}>{s.balance}</td>
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
