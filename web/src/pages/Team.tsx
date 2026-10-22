import { useCallback, useEffect, useState } from "react";
import { supabase, shrinkImage, signedUrl } from "../lib/supabase";
import type { Ctx } from "../App";

type Member = { user_id: string; role: string; created_at: string };
type Invite = { id: string; email: string; role: string; accepted_at: string | null; created_at: string };

export default function Team({ ctx }: { ctx: Ctx }) {
  const store = ctx.membership.stores;
  const isOwner = ctx.membership.role === "owner";
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("staff");
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: store.name, city: store.city ?? "", phone: store.phone ?? "", email: store.email ?? "", address: store.address ?? "", website: store.website ?? "",
    tagline: store.tagline ?? "", cta_text: store.cta_text ?? "", brand_color: store.brand_color ?? "#9a5a1c",
  });
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: m } = await supabase.from("store_members").select("user_id, role, created_at").eq("store_id", store.id);
    setMembers((m ?? []) as Member[]);
    if (isOwner) { const { data: i } = await supabase.from("store_invites").select("*").eq("store_id", store.id).order("created_at", { ascending: false }); setInvites((i ?? []) as Invite[]); }
    if (store.logo_path) setLogoUrl(await signedUrl("brand", store.logo_path));
  }, [store.id, store.logo_path, isOwner]);
  useEffect(() => { load(); }, [load]);

  async function saveStore(e: React.FormEvent) {
    e.preventDefault(); setSaving(true); setSaveErr(null);
    const patch = { ...form, city: form.city || null, phone: form.phone || null, email: form.email || null, address: form.address || null, website: form.website || null, tagline: form.tagline || null, cta_text: form.cta_text || null };
    const { error } = await supabase.from("stores").update(patch).eq("id", store.id);
    setSaving(false);
    if (error) { setSaveErr(error.message); return; }
    ctx.toast("Store details saved."); ctx.reloadStore();
  }
  async function uploadLogo(f: File | undefined) {
    if (!f) return;
    const blob = f.type === "image/svg+xml" ? f : await shrinkImage(f, 1200, 0.95);
    const isPng = f.type === "image/png"; const ext = f.type === "image/svg+xml" ? "svg" : isPng ? "png" : "jpg";
    const path = `${store.id}/logo-${Date.now()}.${ext}`;
    const up = await supabase.storage.from("brand").upload(path, isPng ? f : blob, { contentType: f.type === "image/svg+xml" ? "image/svg+xml" : isPng ? "image/png" : "image/jpeg" });
    if (up.error) { ctx.toast("Logo upload failed: " + up.error.message); return; }
    const { error } = await supabase.from("stores").update({ logo_path: path }).eq("id", store.id);
    if (error) { ctx.toast(error.message); return; }
    ctx.toast("Logo saved. PNG or JPG logos go on the PDF; SVG shows in-app only."); ctx.reloadStore();
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    const { error } = await supabase.from("store_invites").insert({ store_id: store.id, email: email.trim().toLowerCase(), role, created_by: ctx.session.user.id });
    if (error) { setErr(error.message); return; }
    ctx.toast(`Invited ${email}. They sign up with that email and they're in.`); setEmail(""); load();
  }
  async function revoke(i: Invite) { await supabase.from("store_invites").delete().eq("id", i.id); load(); }
  async function removeMember(m: Member) { if (!isOwner || m.user_id === ctx.session.user.id) return; await supabase.from("store_members").delete().eq("store_id", store.id).eq("user_id", m.user_id); load(); }

  return (
    <div className="two">
      <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 0 }}>
        <form className="card" onSubmit={saveStore}>
          <h2>Store details · on every proposal</h2>
          {!isOwner && <p className="small muted">Only owners can edit these.</p>}
          <fieldset disabled={!isOwner} style={{ border: 0, padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="grid2">
              <label className="f">Store name<input type="text" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
              <label className="f">City<input type="text" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} /></label>
            </div>
            <div className="grid2">
              <label className="f">Phone<input type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
              <label className="f">Email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            </div>
            <label className="f">Showroom address<input type="text" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></label>
            <div className="grid2">
              <label className="f">Website<input type="text" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} placeholder="floorandmorecanada.com" /></label>
              <label className="f">Brand colour<input type="color" value={/^#[0-9a-f]{6}$/i.test(form.brand_color) ? form.brand_color : "#9a5a1c"} onChange={(e) => setForm({ ...form, brand_color: e.target.value })} /></label>
            </div>
            <label className="f">Tagline (cover page)<input type="text" value={form.tagline} onChange={(e) => setForm({ ...form, tagline: e.target.value })} placeholder="Tile & vinyl, Edmonton since 2012" /></label>
            <label className="f">Closing-page headline<input type="text" value={form.cta_text} onChange={(e) => setForm({ ...form, cta_text: e.target.value })} placeholder="Book your free in-home measure" /></label>
            <div className="row">
              {logoUrl && <img src={logoUrl} alt="Logo" style={{ height: 40, maxWidth: 160, objectFit: "contain", background: "#fff", padding: 4, borderRadius: 4 }} />}
              <label className="f">Logo (PNG/JPG, optional)<input type="file" accept="image/png,image/jpeg,image/svg+xml" onChange={(e) => { uploadLogo(e.target.files?.[0]); e.target.value = ""; }} /></label>
            </div>
            <div className="row"><button className="primary" disabled={saving}>{saving ? <span className="spinner" /> : "Save details"}</button>{saveErr && <span className="warn small">{saveErr}</span>}</div>
          </fieldset>
        </form>

        {isOwner && (
          <form className="card" onSubmit={invite}>
            <h2>Invite staff</h2>
            <label className="f">Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label className="f">Role<select value={role} onChange={(e) => setRole(e.target.value)}><option value="staff">Staff — generate, add products</option><option value="owner">Owner — everything</option></select></label>
            <button className="primary">Send invite</button>
            {err && <p className="warn small">{err}</p>}
            <p className="small muted">No email is sent. Tell them to create an account at this address with that email; they're added automatically.</p>
          </form>
        )}
      </div>

      <div className="card">
        <h2>Members</h2>
        <div className="table-wrap"><table>
          <thead><tr><th>User</th><th>Role</th><th>Since</th><th></th></tr></thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.user_id}>
                <td className="mono small">{m.user_id === ctx.session.user.id ? `${ctx.session.user.email} (you)` : m.user_id.slice(0, 8) + "…"}</td>
                <td>{m.role}</td>
                <td className="muted">{new Date(m.created_at).toLocaleDateString("en-CA")}</td>
                <td>{isOwner && m.user_id !== ctx.session.user.id && <button className="sm ghost" onClick={() => removeMember(m)}>Remove</button>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        {isOwner && invites.length > 0 && (
          <>
            <h3>Invites</h3>
            <div className="table-wrap"><table>
              <thead><tr><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {invites.map((i) => (
                  <tr key={i.id}>
                    <td>{i.email}</td><td>{i.role}</td>
                    <td><span className={"status " + (i.accepted_at ? "done" : "")}>{i.accepted_at ? "joined" : "pending"}</span></td>
                    <td>{!i.accepted_at && <button className="sm ghost" onClick={() => revoke(i)}>Revoke</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </>
        )}
      </div>
    </div>
  );
}
