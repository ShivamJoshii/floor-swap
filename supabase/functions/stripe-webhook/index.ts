// Floor Swap — stripe-webhook: keeps store billing state in sync and credits pack purchases.
// Verifies the Stripe signature manually (HMAC-SHA256) — no SDK needed. verify_jwt must be OFF for this function.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET");
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY");

async function verify(payload: string, header: string | null): Promise<boolean> {
  if (!WEBHOOK_SECRET || !header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = parts.t, v1 = parts.v1; if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  const hex = Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== v1.length) return false;
  let diff = 0; for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}
async function stripeGet(path: string) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, { headers: { Authorization: `Bearer ${STRIPE_KEY}` } });
  return res.ok ? await res.json() : null;
}
const iso = (sec?: number | null) => sec ? new Date(sec * 1000).toISOString() : null;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("ok");
  const payload = await req.text();
  if (!(await verify(payload, req.headers.get("stripe-signature")))) return new Response("bad signature", { status: 400 });
  const event = JSON.parse(payload) as { id: string; type: string; data: { object: Record<string, unknown> } };
  const svc = createClient(SUPABASE_URL, SERVICE_KEY);
  const obj = event.data.object;

  // Idempotency: record event ids.
  const { error: dup } = await svc.from("stripe_events").insert({ id: event.id, type: event.type });
  if (dup) return new Response("already handled");

  try {
    if (event.type === "checkout.session.completed") {
      const meta = (obj.metadata ?? {}) as Record<string, string>;
      const storeId = meta.store_id;
      if (obj.mode === "payment" && storeId && meta.pack_id) {
        const credits = Number(meta.credits ?? 0);
        if (credits > 0) await svc.from("credit_ledger").insert({ store_id: storeId, delta: credits, reason: "purchase", pack_id: meta.pack_id, note: `Stripe ${obj.id}` });
      }
      if (obj.mode === "subscription" && storeId && obj.subscription) {
        const sub = await stripeGet(`subscriptions/${obj.subscription}`);
        await applySubscription(svc, storeId, sub, meta.plan_id);
      }
    }
    if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted" || event.type === "customer.subscription.created") {
      const sub = obj as Record<string, unknown>;
      const meta = (sub.metadata ?? {}) as Record<string, string>;
      let storeId = meta.store_id;
      if (!storeId) { const { data } = await svc.from("stores").select("id").eq("stripe_customer_id", sub.customer as string).maybeSingle(); storeId = data?.id; }
      if (storeId) await applySubscription(svc, storeId, sub, meta.plan_id);
    }
    if (event.type === "invoice.paid") {
      // New billing period: refresh period bounds from the subscription.
      const subId = obj.subscription as string | undefined;
      if (subId) {
        const sub = await stripeGet(`subscriptions/${subId}`);
        const { data } = await svc.from("stores").select("id, plan_id").eq("stripe_subscription_id", subId).maybeSingle();
        if (data && sub) await applySubscription(svc, data.id, sub, data.plan_id);
      }
    }
    if (event.type === "invoice.payment_failed") {
      const subId = obj.subscription as string | undefined;
      if (subId) await svc.from("stores").update({ plan_status: "past_due" }).eq("stripe_subscription_id", subId);
    }
  } catch (e) {
    console.error("webhook error", event.type, e);
    return new Response("error", { status: 500 });
  }
  return new Response("ok");
});

async function applySubscription(svc: ReturnType<typeof createClient>, storeId: string, sub: Record<string, unknown> | null, planHint?: string | null) {
  if (!sub) return;
  const status = String(sub.status ?? "");
  const items = (sub.items as { data?: { price?: { id: string; recurring?: { interval?: string }; metadata?: Record<string, string> } }[] })?.data ?? [];
  const price = items[0]?.price;
  let planId = planHint ?? price?.metadata?.plan_id ?? null;
  if (!planId && price?.id) {
    const { data } = await svc.from("plans").select("id").or(`stripe_price_month.eq.${price.id},stripe_price_year.eq.${price.id}`).maybeSingle();
    planId = data?.id ?? null;
  }
  const active = status === "active" || status === "trialing";
  const canceled = status === "canceled" || status === "unpaid" || status === "incomplete_expired";
  await svc.from("stores").update({
    stripe_subscription_id: sub.id as string,
    plan_id: planId,
    plan_status: active ? "active" : status === "past_due" ? "past_due" : canceled ? "canceled" : "active",
    billing_interval: price?.recurring?.interval ?? null,
    period_start: iso(sub.current_period_start as number), period_end: iso(sub.current_period_end as number),
    watermark: !active,
  }).eq("id", storeId);
}
