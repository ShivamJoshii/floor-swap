import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, configured, type Membership } from "./lib/supabase";
import Login from "./pages/Login";
import Onboard from "./pages/Onboard";
import Generate from "./pages/Generate";
import Products from "./pages/Products";
import Credits from "./pages/Credits";
import Team from "./pages/Team";
import Admin from "./pages/Admin";

type Tab = "generate" | "products" | "credits" | "team" | "admin";

export type Ctx = {
  session: Session;
  membership: Membership;
  balance: number | null;
  refreshBalance: () => Promise<void>;
  toast: (msg: string) => void;
  isAdmin: boolean;
};

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [memberships, setMemberships] = useState<Membership[] | null>(null);
  const [storeId, setStoreId] = useState<string | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [tab, setTab] = useState<Tab>("generate");
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const toast = useCallback((msg: string) => { setToastMsg(msg); window.setTimeout(() => setToastMsg(null), 3200); }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const loadMemberships = useCallback(async () => {
    if (!session) return;
    await supabase.rpc("accept_invites").then(() => undefined, () => undefined);
    const { data } = await supabase.from("store_members").select("store_id, role, stores(id, name, city)").order("created_at");
    const list = (data ?? []) as unknown as Membership[];
    setMemberships(list);
    setStoreId((cur) => cur && list.some((m) => m.store_id === cur) ? cur : (list[0]?.store_id ?? null));
    const { data: adm } = await supabase.from("platform_admins").select("user_id").eq("user_id", session.user.id).maybeSingle();
    setIsAdmin(Boolean(adm));
  }, [session]);

  useEffect(() => { if (session) loadMemberships(); else setMemberships(null); }, [session, loadMemberships]);

  const refreshBalance = useCallback(async () => {
    if (!storeId) return;
    const { data } = await supabase.rpc("store_balance", { p_store: storeId });
    setBalance(typeof data === "number" ? data : null);
  }, [storeId]);
  useEffect(() => { refreshBalance(); }, [refreshBalance]);

  if (!configured) return <div className="page"><div className="card"><h2>Setup</h2><p>Missing <span className="mono">VITE_SUPABASE_URL</span> / <span className="mono">VITE_SUPABASE_KEY</span>. Add them to the Netlify environment and redeploy.</p></div></div>;
  if (session === undefined) return <div className="page"><p className="muted">Loading…</p></div>;
  if (!session) return <Login />;
  if (memberships === null) return <div className="page"><p className="muted">Loading your store…</p></div>;

  const membership = memberships.find((m) => m.store_id === storeId) ?? null;
  if (!membership) return <Onboard onDone={loadMemberships} toast={toast} email={session.user.email ?? ""} />;

  const ctx: Ctx = { session, membership, balance, refreshBalance, toast, isAdmin };
  const tabs: [Tab, string][] = [["generate", "Generate"], ["products", "Products"], ["credits", "Credits"], ["team", "Team"]];
  if (isAdmin) tabs.push(["admin", "Admin"]);

  return (
    <>
      <header className="topbar">
        <span className="brand">Floor Swap</span>
        {memberships.length > 1 ? (
          <select value={storeId ?? ""} onChange={(e) => setStoreId(e.target.value)} style={{ width: "auto" }} aria-label="Store">
            {memberships.map((m) => <option key={m.store_id} value={m.store_id}>{m.stores.name}</option>)}
          </select>
        ) : <span className="muted">{membership.stores.name}</span>}
        <nav>{tabs.map(([t, l]) => <button key={t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{l}</button>)}</nav>
        <div className="right">
          <span className={"credits-pill" + (balance !== null && balance <= 3 ? " low" : "")} title="Credits left">{balance === null ? "…" : `${balance} credit${balance === 1 ? "" : "s"}`}</span>
          <span className="muted small">{session.user.email}</span>
          <button className="sm ghost" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </header>
      <main className="page">
        {tab === "generate" && <Generate ctx={ctx} />}
        {tab === "products" && <Products ctx={ctx} />}
        {tab === "credits" && <Credits ctx={ctx} />}
        {tab === "team" && <Team ctx={ctx} />}
        {tab === "admin" && isAdmin && <Admin ctx={ctx} />}
      </main>
      {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
    </>
  );
}
