import { useState } from "react";
import { supabase } from "../lib/supabase";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"signin" | "signup" | "magic">("signin");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setMsg(null);
    try {
      if (mode === "magic") {
        const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
        setMsg(error ? error.message : "Check your email for the sign-in link.");
      } else if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
        if (error) setMsg(error.message);
        else if (data.session) setMsg(null);
        else setMsg("Account created. Confirm the email we sent, then sign in.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) setMsg(error.message);
      }
    } finally { setBusy(false); }
  }

  return (
    <div className="page">
      <form className="card auth" onSubmit={submit}>
        <h1>Floor Swap</h1>
        <p className="muted">Room photo + your real product → mockup in a minute.</p>
        <div className="seg" role="tablist">
          <button type="button" className={mode === "signin" ? "on" : ""} onClick={() => setMode("signin")}>Sign in</button>
          <button type="button" className={mode === "signup" ? "on" : ""} onClick={() => setMode("signup")}>Create account</button>
          <button type="button" className={mode === "magic" ? "on" : ""} onClick={() => setMode("magic")}>Email link</button>
        </div>
        <label className="f">Email<input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
        {mode !== "magic" && (
          <label className="f">Password<input id="password" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "signup" ? "new-password" : "current-password"} /></label>
        )}
        <button className="primary" disabled={busy}>{busy ? <span className="spinner" /> : mode === "signup" ? "Create account" : mode === "magic" ? "Send link" : "Sign in"}</button>
        {msg && <p className="small">{msg}</p>}
      </form>
    </div>
  );
}
