import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, configured, type Membership } from "./lib/supabase";
import type { ProposalItem } from "./lib/pdf";
import Login from "./pages/Login";
import Onboard from "./pages/Onboard";
import Generate from "./pages/Generate";
import Products from "./pages/Products";
import Proposal from "./pages/Proposal";
import Credits from "./pages/Credits";
import Team from "./pages/Team";
import Admin from "./pages/Admin";
import Marketplace from "./pages/Marketplace";
import SupplierPage from "./pages/SupplierPage";

type Tab = "generate" | "proposal" | "products" | "marketplace" | "supplier" | "credits" | "team" | "admin";

export type Ctx = {
  session: Session;
  membership: Membership;
  balance: number | null;
  hasAllowance: boolean;
  watermark: boolean;
  refreshBalance: () => Promise<void>;
  reloadStore: () => Promise<void>;
  toast: (msg: string) => void;
  isAdmin: boolean;
  proposal: ProposalItem[];
  setProposal: (fn: (cur: ProposalItem[]) => ProposalItem[]) => void;
  goTo: (tab: Tab) => void;
};

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [memberships, setMemberships] = useState<Membership[] | null>(null);
  const [supplierIds, setSupplierIds] = useState<string[]>([]);
  const [mode, setMode] = useState<"store" | "supplier">("store");
  const [storeId, setStoreId] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [usage, setUsage] = useState<{ plan_status: string; renders_per_month: number; used_this_period: number; credits: number | null; watermark?: boolean } | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [tab, setTab] = useState<Tab>("generate");
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [proposal, setProposalState] = useState<ProposalItem[]>([]);

  const toast = useCallback((msg: string) => { setToastMsg(msg); window.setTimeout(() => setToastMsg(null), 3200); }, []);
  const setProposal = useCallback((fn: (cur: ProposalItem[]) => ProposalItem[]) => setProposalState((cur) => fn(cur)), []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const loadMemberships = useCallback(async () => {
    if (!session) return;
    await Promise.all([supabase.rpc("accept_invites").then(() => undefined, () => undefined), supabase.rpc("accept_supplier_invites").then(() => undefined, () => undefined)]);
    const [{ data }, { data: sm }] = await Promise.all([
      supabase.from("store_members").select("store_id, role, stores(*)").order("created_at"),
      supabase.from("supplier_members").select("supplier_id").eq("user_id", session.user.id),
    ]);
    const list = (data ?? []) as unknown as Membership[];
    setMemberships(list);
    const sids = ((sm ?? []) as { supplier_id: string }[]).map((x) => x.supplier_id); setSupplierIds(sids);
    if (!list.length && sids.length) setMode("supplier");
    setStoreId((cur) => cur && list.some((m) => m.store_id === cur) ? cur : (list[0]?.store_id ?? null));
    const { data: adm } = await supabase.from("platform_admins").select("user_id").eq("user_id", session.user.id).maybeSingle();
    setIsAdmin(Boolean(adm));
  }, [session]);

  useEffect(() => { if (session) loadMemberships(); else setMemberships(null); }, [session, loadMemberships]);

  const refreshBalance = useCallback(async () => {
    if (!storeId) return;
    const [{ data }, { data: u }] = await Promise.all([supabase.rpc("store_balance", { p_store: storeId }), supabase.rpc("store_usage", { p_store: storeId })]);
    setBalance(typeof data === "number" ? data : null);
    const row = Array.isArray(u) ? u[0] : u; setUsage(row ?? null);
  }, [storeId]);
  useEffect(() => { refreshBalance(); setProposalState([]); }, [refreshBalance]);

  if (!configured) return <div className="page"><div className="card"><h2>Setup</h2><p>Missing <span className="mono">VITE_SUPABASE_URL</span> / <span className="mono">VITE_SUPABASE_KEY</span>. Add them to the Netlify environment and redeploy.</p></div></div>;
  if (session === undefined) return <div className="page"><p className="muted">Loading…</p></div>;
  if (!session) return <Login />;
  if (memberships === null) return <div className="page"><p className="muted">Loading your store…</p></div>;

  const membership = memberships.find((m) => m.store_id === storeId) ?? null;
  // Standalone supplier account (no store): supplier-only shell.
  if (!membership && (supplierIds.length || mode === "supplier")) {
    return (
      <>
        <header className="topbar">
          <span className="brand">Floor Swap</span><span className="muted">Supplier</span>
          <div className="right"><span className="muted small">{session.user.email}</span><button className="sm ghost" onClick={() => supabase.auth.signOut()}>Sign out</button></div>
        </header>
        <main className="page">
          <SupplierPage ctx={null} supplierId={supplierIds[0]} />
          {!supplierIds.length && <p className="small muted">Run a store instead? <button className="sm ghost" onClick={() => setMode("store")}>Set up a store</button></p>}
        </main>
      </>
    );
  }
  if (!membership) return <Onboard onDone={loadMemberships} toast={toast} email={session.user.email ?? ""} onSupplier={() => setMode("supplier")} />;

  const ctx: Ctx = { session, membership, balance, hasAllowance: !!(usage && usage.plan_status === "active" && usage.used_this_period < usage.renders_per_month), watermark: !!usage?.watermark, refreshBalance, reloadStore: loadMemberships, toast, isAdmin, proposal, setProposal, goTo: setTab };
  const tabs: [Tab, string][] = [["generate", "Create"], ["proposal", proposal.length ? `Proposal · ${proposal.length}` : "Proposal"], ["products", "Products"], ["marketplace", "Suppliers"]];
  const menu: [Tab, string][] = [["credits", "Plan & billing"], ["team", "Store settings"], ["supplier", "Sell wholesale"]];
  if (isAdmin) menu.push(["admin", "Admin"]);
  const pill = usage?.plan_status === "active" && usage.renders_per_month > 0
    ? { text: `${Math.max(0, usage.renders_per_month - usage.used_this_period)} left`, low: usage.used_this_period >= usage.renders_per_month * 0.9 }
    : { text: balance === null ? "…" : `${balance} left${usage?.plan_status === "trial" ? " · trial" : ""}`, low: balance !== null && balance <= 3 };

  return (
    <>
      <header className="topbar">
        <span className="brand" onClick={() => setTab("generate")} style={{ cursor: "pointer" }}>Floor Swap</span>
        <nav>{tabs.map(([t, l]) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{l}</button>)}</nav>
        <div className="right">
          <button className={"credits-pill" + (pill.low ? " low" : "")} title="Renders" onClick={() => setTab("credits")}>{pill.text}</button>
          <details className="menu">
            <summary>{membership.stores.name}</summary>
            <div className="menu-pop" onClick={(e) => { const d = e.currentTarget.parentElement as HTMLDetailsElement; if ((e.target as HTMLElement).tagName === "BUTTON") d.open = false; }}>
              {memberships.length > 1 && (
                <select value={storeId ?? ""} onChange={(e) => setStoreId(e.target.value)} aria-label="Switch store">
                  {memberships.map((m) => <option key={m.store_id} value={m.store_id}>{m.stores.name}</option>)}
                </select>
              )}
              {menu.map(([t, l]) => <button key={t} className={"ghost" + (tab === t ? " on" : "")} onClick={() => setTab(t)}>{l}</button>)}
              <hr />
              <span className="small muted" style={{ padding: "0 12px" }}>{session.user.email}</span>
              <button className="ghost" onClick={() => supabase.auth.signOut()}>Sign out</button>
            </div>
          </details>
        </div>
      </header>
      <main className="page">
        {tab === "generate" && <Generate ctx={ctx} />}
        {tab === "proposal" && <Proposal ctx={ctx} />}
        {tab === "products" && <Products ctx={ctx} />}
        {tab === "marketplace" && <Marketplace ctx={ctx} />}
        {tab === "supplier" && <SupplierPage ctx={ctx} />}
        {tab === "credits" && <Credits ctx={ctx} />}
        {tab === "team" && <Team ctx={ctx} />}
        {tab === "admin" && isAdmin && <Admin ctx={ctx} />}
      </main>
      {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
    </>
  );
}
