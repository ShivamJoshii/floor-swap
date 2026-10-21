import { useCallback, useEffect, useState } from "react";
import { supabase, money, SALES_CONTACT, type Pack } from "../lib/supabase";
import type { Ctx } from "../App";

type Row = { id: number; delta: number; reason: string; note: string | null; pack_id: string | null; created_at: string };

export default function Credits({ ctx }: { ctx: Ctx }) {
  const store = ctx.membership.store_id;
  const [packs, setPacks] = useState<Pack[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [chosen, setChosen] = useState<Pack | null>(null);

  const load = useCallback(async () => {
    const [{ data: p }, { data: l }] = await Promise.all([
      supabase.from("credit_packs").select("*").eq("active", true).order("sort"),
      supabase.from("credit_ledger").select("id, delta, reason, note, pack_id, created_at").eq("store_id", store).order("created_at", { ascending: false }).limit(50),
    ]);
    setPacks((p ?? []) as Pack[]); setRows((l ?? []) as Row[]);
  }, [store]);
  useEffect(() => { load(); ctx.refreshBalance(); }, [load, ctx]);

  const used = rows.filter((r) => r.reason === "generation").length;
  const subject = chosen ? `Floor Swap credits: ${chosen.name} (${chosen.credits}) for ${ctx.membership.stores.name}` : "";
  const mailto = chosen ? `mailto:${SALES_CONTACT}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(`Store: ${ctx.membership.stores.name}\nPack: ${chosen.name} — ${chosen.credits} credits, ${money(chosen.price_cents, chosen.currency)}\nAccount email: ${ctx.session.user.email}`)}` : "#";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="card">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <h2>Balance</h2>
          <span className="mono">{ctx.balance ?? "…"} credits · {used} used</span>
        </div>
        <p className="muted small">1 credit = 1 generation = 3 options. Credits are prepaid and never expire.</p>
        <div className="packs">
          {packs.map((p, i) => (
            <div key={p.id} className={"pack" + (i === 1 ? " best" : "")}>
              <strong>{p.name}</strong>
              <div className="price">{money(p.price_cents, p.currency)}</div>
              <div className="muted small">{p.credits} credits · {money(p.price_cents / p.credits, p.currency)} per generation</div>
              <button className={i === 1 ? "primary" : ""} onClick={() => setChosen(p)}>Buy</button>
            </div>
          ))}
        </div>
        {chosen && (
          <div className="card" style={{ background: "var(--bg)" }}>
            <strong>{chosen.name} · {chosen.credits} credits · {money(chosen.price_cents, chosen.currency)}</strong>
            <p className="small">Card checkout is coming. For now, email <span className="mono">{SALES_CONTACT}</span> and the credits are added to your account the same day.</p>
            <div className="row">
              <a className="primary" href={mailto} style={{ textDecoration: "none" }}><button className="primary" type="button">Open email</button></a>
              <button className="sm" onClick={() => { navigator.clipboard.writeText(`${subject}\nAccount: ${ctx.session.user.email}`).then(() => ctx.toast("Copied."), () => ctx.toast("Copy blocked.")); }}>Copy request</button>
              <button className="sm ghost" onClick={() => setChosen(null)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      <div className="card">
        <h2>History</h2>
        {!rows.length && <p className="muted">No activity yet.</p>}
        {rows.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th>When</th><th>What</th><th className="num">Credits</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="muted">{new Date(r.created_at).toLocaleString("en-CA", { dateStyle: "short", timeStyle: "short" })}</td>
                  <td>{r.reason}{r.pack_id ? ` · ${r.pack_id}` : ""}{r.note ? <span className="muted"> — {r.note}</span> : ""}</td>
                  <td className="num" style={{ color: r.delta < 0 ? "var(--muted)" : "var(--ok)" }}>{r.delta > 0 ? "+" : ""}{r.delta}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </div>
    </div>
  );
}
