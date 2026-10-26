// Floor Swap — billing-portal: open the Stripe customer portal (change plan, card, cancel, invoices).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY");
const APP_URL = Deno.env.get("APP_URL") ?? "https://floor-swap-app.netlify.app";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!STRIPE_KEY) return json({ error: "Billing is not set up yet." }, 500);
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "Not signed in." }, 401);
  const body = await req.json().catch(() => null) as { store_id?: string } | null;
  if (!body?.store_id) return json({ error: "store_id required." }, 400);
  const svc = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: member } = await svc.from("store_members").select("role").eq("store_id", body.store_id).eq("user_id", user.id).maybeSingle();
  if (!member || member.role !== "owner") return json({ error: "Only a store owner can manage billing." }, 403);
  const { data: store } = await svc.from("stores").select("stripe_customer_id").eq("id", body.store_id).single();
  if (!store?.stripe_customer_id) return json({ error: "No billing account yet. Pick a plan first." }, 400);
  const res = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
    method: "POST", headers: { Authorization: `Bearer ${STRIPE_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ customer: store.stripe_customer_id, return_url: `${APP_URL}/?billing=portal` }).toString(),
  });
  const out = await res.json();
  if (!res.ok) return json({ error: out?.error?.message ?? "Stripe error" }, 502);
  return json({ url: out.url });
});
