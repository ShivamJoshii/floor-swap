// Floor Swap — generate: room photo + product swatch -> N rendered options via fal.
// Charges prepaid credits atomically; refunds on provider failure.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FAL_KEY = Deno.env.get("FAL_KEY");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Options = { direction?: string; pattern?: string; extra?: string };

function buildPrompt(p: { name: string; type: string; length_in: number | null; width_in: number | null }, o: Options) {
  const dims = p.length_in && p.width_in ? `${p.length_in} by ${p.width_in} inch` : "";
  const unit = p.type === "tile" ? `${dims} tiles` : p.type === "carpet" ? "carpet" : `${dims} planks`;
  const dir: Record<string, string> = {
    along: "running front-to-back, away from the camera",
    across: "running left-to-right across the room",
    diagonal: "laid diagonally at 45 degrees",
  };
  const pat: Record<string, string> = {
    straight: "in a straight staggered layout",
    herringbone: "in a herringbone layout",
    grid: "in a straight grid with thin grout lines",
    offset: "in an offset brick layout with thin grout lines",
  };
  const parts = [
    "Edit the FIRST image. Replace only the existing floor with the flooring product shown in the SECOND image.",
    `The product is ${p.name}: ${unit}${p.type === "carpet" ? "" : " at realistic scale, correct perspective, plank edges visible"}`,
    o.pattern && pat[o.pattern] ? pat[o.pattern] : "",
    o.direction && dir[o.direction] ? dir[o.direction] : "",
    "Match the product's exact colour, grain and pattern from the second image. Do not invent a different wood tone.",
    "Keep everything else identical: walls, furniture, rugs on top of the floor, doors, trim, lighting, shadows, reflections, camera angle and framing.",
    "Photorealistic, same resolution and aspect ratio as the first image.",
    o.extra ?? "",
  ].filter(Boolean);
  return parts.join(" ");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!FAL_KEY) return json({ error: "FAL_KEY is not set. Add it in Supabase → Edge Functions → Secrets." }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "Not signed in." }, 401);

  const body = await req.json().catch(() => null) as
    | { store_id?: string; product_id?: string; room_path?: string; options?: Options; lead_name?: string; lead_phone?: string }
    | null;
  if (!body?.store_id || !body.product_id || !body.room_path) return json({ error: "store_id, product_id and room_path are required." }, 400);
  if (!body.room_path.startsWith(`${body.store_id}/`)) return json({ error: "room_path must be inside the store folder." }, 400);

  const svc = createClient(SUPABASE_URL, SERVICE_KEY);

  const { data: member } = await svc.from("store_members").select("role").eq("store_id", body.store_id).eq("user_id", user.id).maybeSingle();
  if (!member) return json({ error: "You are not a member of this store." }, 403);

  const { data: product } = await svc.from("products").select("id, name, type, length_in, width_in, swatch_path, store_id, active")
    .eq("id", body.product_id).eq("store_id", body.store_id).maybeSingle();
  if (!product || !product.active) return json({ error: "Product not found." }, 404);

  const { data: settingsRows } = await svc.from("app_settings").select("key, value");
  const settings: Record<string, unknown> = {};
  for (const r of settingsRows ?? []) settings[r.key] = r.value;
  const model = String(settings.model ?? "fal-ai/nano-banana-2/edit");
  const numImages = Math.min(4, Math.max(1, Number(settings.images_per_generation ?? 3)));
  const credits = Math.max(1, Number(settings.credits_per_generation ?? 1));
  const costPerImage = Number(settings.provider_cost_cents_per_image ?? 0);
  const options: Options = body.options ?? {};
  const prompt = buildPrompt(product, options);

  const { data: render, error: rerr } = await svc.from("renders").insert({
    store_id: body.store_id, product_id: product.id, user_id: user.id, room_path: body.room_path,
    status: "running", model, prompt, options, credits_charged: credits,
    lead_name: body.lead_name ?? null, lead_phone: body.lead_phone ?? null,
  }).select("id").single();
  if (rerr || !render) return json({ error: "Could not create render: " + (rerr?.message ?? "") }, 500);

  const { error: cerr } = await svc.rpc("consume_credits", { p_store: body.store_id, p_amount: credits, p_render: render.id });
  if (cerr) {
    await svc.from("renders").update({ status: "failed", error: cerr.message, credits_charged: 0, finished_at: new Date().toISOString() }).eq("id", render.id);
    const low = /insufficient/i.test(cerr.message);
    return json({ error: low ? "No credits left. Top up to keep generating." : cerr.message, render_id: render.id }, low ? 402 : 500);
  }

  const fail = async (msg: string, status = 502) => {
    await svc.from("credit_ledger").insert({ store_id: body.store_id, delta: credits, reason: "refund", render_id: render.id, note: msg.slice(0, 200) });
    await svc.from("renders").update({ status: "failed", error: msg.slice(0, 1000), finished_at: new Date().toISOString() }).eq("id", render.id);
    return json({ error: msg, render_id: render.id, refunded: true }, status);
  };

  try {
    const [room, swatch] = await Promise.all([
      svc.storage.from("rooms").createSignedUrl(body.room_path, 3600),
      svc.storage.from("swatches").createSignedUrl(product.swatch_path, 3600),
    ]);
    if (room.error || !room.data) return await fail("Room photo not found in storage.", 400);
    if (swatch.error || !swatch.data) return await fail("Swatch photo not found in storage.", 400);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 140_000);
    const res = await fetch(`https://fal.run/${model}`, {
      method: "POST",
      headers: { Authorization: `Key ${FAL_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, image_urls: [room.data.signedUrl, swatch.data.signedUrl], num_images: numImages, output_format: "jpeg" }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return await fail(`Image provider error ${res.status}: ${text.slice(0, 300)}`);
    }
    const out = await res.json() as { images?: { url: string; width?: number; height?: number; content_type?: string }[] };
    const images = out.images ?? [];
    if (!images.length) return await fail("Image provider returned no images.");

    const outputs: { path: string; width?: number; height?: number }[] = [];
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      const r = await fetch(img.url);
      if (!r.ok) continue;
      const buf = new Uint8Array(await r.arrayBuffer());
      const ct = img.content_type ?? r.headers.get("content-type") ?? "image/jpeg";
      const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
      const path = `${body.store_id}/${render.id}/${i + 1}.${ext}`;
      const up = await svc.storage.from("renders").upload(path, buf, { contentType: ct, upsert: true });
      if (!up.error) outputs.push({ path, width: img.width, height: img.height });
    }
    if (!outputs.length) return await fail("Could not store the generated images.");

    await svc.from("renders").update({
      status: "done", outputs, provider_cost_cents: costPerImage * images.length, finished_at: new Date().toISOString(),
    }).eq("id", render.id);

    const signed = await Promise.all(outputs.map((o) => svc.storage.from("renders").createSignedUrl(o.path, 3600)));
    const balance = await svc.rpc("store_balance", { p_store: body.store_id });
    return json({
      render_id: render.id,
      outputs: outputs.map((o, i) => ({ ...o, url: signed[i].data?.signedUrl ?? null })),
      balance: balance.data ?? null,
    });
  } catch (e) {
    const msg = e instanceof Error ? (e.name === "AbortError" ? "Image provider timed out (140 s)." : e.message) : String(e);
    return await fail(msg);
  }
});
