import { useState } from "react";
import { supabase } from "../lib/supabase";

export default function Onboard({ onDone, toast, email, onSupplier }: { onDone: () => Promise<void>; toast: (m: string) => void; email: string; onSupplier?: () => void }) {
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    const { error } = await supabase.rpc("create_store", { p_name: name, p_city: city });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    toast(`${name} is set up.`);
    await onDone();
  }

  return (
    <div className="page">
      <form className="card auth" onSubmit={create}>
        <h1>Set up your store</h1>
        <p className="muted">Signed in as {email}. If your store already exists, ask the owner to invite this email under Team.</p>
        <label className="f">Store name<input id="storeName" type="text" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Floor & More" /></label>
        <label className="f">City<input id="storeCity" type="text" value={city} onChange={(e) => setCity(e.target.value)} placeholder="Edmonton" /></label>
        <button className="primary" disabled={busy}>{busy ? <span className="spinner" /> : "Create store"}</button>
        {err && <p className="warn small">{err}</p>}
        {onSupplier && <p className="small muted">Not a store? <button type="button" className="sm ghost" style={{ padding: "0 4px" }} onClick={onSupplier}>I'm a supplier or distributor</button></p>}
        <div className="row"><button type="button" className="sm ghost" onClick={() => supabase.auth.signOut()}>Sign out</button></div>
      </form>
    </div>
  );
}
