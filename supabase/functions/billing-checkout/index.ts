// Floor Swap — billing-checkout: start a Stripe Checkout session for a plan (subscription) or a pack (one-time).
// Creates Stripe products/prices on first use and stores their ids back in plans / credit_packs.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY");
const APP_URL = Deno.env.get("APP_URL") ?? "https://floor-swap-app.netlify.app";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function stripe(path: string, params: Record<string, string>, method = "POST") {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method, headers: { Authorization: `Bearer ${STRIPE_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: method === "POST" ? new URLSearchParams(params).toString() : undefined,
  });
  const out = await res.json();
  if (!res.ok) throw new Error(out?.error?.message ?? `Stripe ${res.status}`);
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (!STRIPE_KEY) return json({ error: "Billing is not set up yet (STRIPE_SECRET_KEY missing)." }, 500);
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "Not signed in." }, 401);

  const body = await req.json().catch(() => null) as { store_id?: string; plan_id?: string; interval?: "month" | "year"; pack_id?: string } | null;
  if (!body?.store_id || (!body.plan_id && !body.pack_id)) return json({ error: "store_id and plan_id or pack_id required." }, 400);
  const svc = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: member } = await svc.from("store_members").select("role").eq("store_id", body.store_id).eq("user_id", user.id).maybeSingle();
  if (!member || member.role !== "owner") return json({ error: "Only a store owner can change billing." }, 403);
  const { data: store } = await svc.from("stores").select("id, name, stripe_customer_id, stripe_subscription_id, plan_status").eq("id", body.store_id).single();
  if (!store) return json({ error: "Store not found." }, 404);

  // Customer
  let customer = store.stripe_customer_id as string | null;
  if (!customer) {
    const c = await stripe("customers", { email: user.email ?? "", name: store.name, "metadata[store_id]": store.id });
    customer = c.id; await svc.from("stores").update({ stripe_customer_id: customer }).eq("id", store.id);
  }

  let priceId: string; let mode: "subscription" | "payment"; const meta: Record<string, string> = { store_id: store.id };
  if (body.plan_id) {
    const interval = body.interval === "year" ? "year" : "month";
    const { data: plan } = await svc.from("plans").select("*").eq("id", body.plan_id).eq("active", true).single();
    if (!plan) return json({ error: "Plan not found." }, 404);
    if (store.stripe_subscription_id && store.plan_status === "active") return json({ error: "This store already has a plan. Use Manage billing to change it." }, 400);
    const col = interval === "year" ? "stripe_price_year" : "stripe_price_month";
    priceId = plan[col];
    if (!priceId) {
      const product = await stripe("products", { name: `Floor Swap ${plan.name}`, "metadata[plan_id]": plan.id });
      const price = await stripe("prices", { product: product.id, currency: "cad", unit_amount: String(interval === "year" ? plan.annual_cents : plan.monthly_cents), "recurring[interval]": interval, "metadata[plan_id]": plan.id });
      priceId = price.id; await svc.from("plans").update({ [col]: priceId }).eq("id", plan.id);
    }
    mode = "subscription"; meta.plan_id = plan.id; meta.interval = interval;
  } else {
    const { data: pack } = await svc.from("credit_packs").select("*").eq("id", body.pack_id!).eq("active", true).single();
    if (!pack) return json({ error: "Pack not found." }, 404);
    priceId = pack.stripe_price;
    if (!priceId) {
      const product = await stripe("products", { name: `Floor Swap top-up: ${pack.name}`, "metadata[pack_id]": pack.id });
      const price = await stripe("prices", { product: product.id, currency: (pack.currency || "cad").toLowerCase(), unit_amount: String(pack.price_cents), "metadata[pack_id]": pack.id });
      priceId = price.id; await svc.from("credit_packs").update({ stripe_price: priceId }).eq("id", pack.id);
    }
    mode = "payment"; meta.pack_id = pack.id; meta.credits = String(pack.credits);
  }

  const params: Record<string, string> = {
    mode, customer: customer!, "line_items[0][price]": priceId, "line_items[0][quantity]": "1",
    success_url: `${APP_URL}/?billing=success`, cancel_url: `${APP_URL}/?billing=cancel`,
    "metadata[store_id]": store.id, allow_promotion_codes: "true",
  };
  for (const [k, v] of Object.entries(meta)) params[`metadata[${k}]`] = v;
  if (mode === "subscription") { for (const [k, v] of Object.entries(meta)) params[`subscription_data[metadata][${k}]`] = v; }
  else params["payment_intent_data[metadata][store_id]"] = store.id;
  try {
    const session = await stripe("checkout/sessions", params);
    return json({ url: session.url });
  } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 502); }
});
