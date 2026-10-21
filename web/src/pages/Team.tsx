import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabase";
import type { Ctx } from "../App";

type Member = { user_id: string; role: string; created_at: string };
type Invite = { id: string; email: string; role: string; accepted_at: string | null; created_at: string };

export default function Team({ ctx }: { ctx: Ctx }) {
  const store = ctx.membership.store_id;
  const isOwner = ctx.membership.role === "owner";
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("staff");
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: m } = await supabase.from("store_members").select("user_id, role, created_at").eq("store_id", store);
    setMembers((m ?? []) as Member[]);
    if (isOwner) { const { data: i } = await supabase.from("store_invites").select("*").eq("store_id", store).order("created_at", { ascending: false }); setInvites((i ?? []) as Invite[]); }
  }, [store, isOwner]);
  useEffect(() => { load(); }, [load]);

  async function invite(e: React.FormEvent) {
    e.preventDefault(); setErr(null);
    const { error } = await supabase.from("store_invites").insert({ store_id: store, email: email.trim().toLowerCase(), role, created_by: ctx.session.user.id });
    if (error) { setErr(error.message); return; }
    ctx.toast(`Invited ${email}. They sign up with that email and they're in.`); setEmail(""); load();
  }
  async function revoke(i: Invite) { await supabase.from("store_invites").delete().eq("id", i.id); load(); }
  async function removeMember(m: Member) { if (!isOwner || m.user_id === ctx.session.user.id) return; await supabase.from("store_members").delete().eq("store_id", store).eq("user_id", m.user_id); load(); }

  return (
    <div className="two">
      <div className="card">
        <h2>Store</h2>
        <p><strong>{ctx.membership.stores.name}</strong>{ctx.membership.stores.city ? <span className="muted"> · {ctx.membership.stores.city}</span> : null}</p>
        <p className="small muted">{members.length} member{members.length === 1 ? "" : "s"}. You are {ctx.membership.role}.</p>
        {isOwner && (
          <form onSubmit={invite} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <h3>Invite staff</h3>
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
