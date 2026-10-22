// Floor Swap — generate: room photo + product swatch -> N rendered options via fal.
// Charges prepaid credits atomically; refunds if every attempt fails.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FAL_KEY = Deno.env.get("FAL_KEY");
const GEMINI_KEY = Deno.env.get("GEMINI_KEY");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Options = { direction?: string; pattern?: string; extra?: string };
type FalImage = { url: string; width?: number; height?: number; content_type?: string };

function buildPrompt(p: { name: string; type: string; length_in: number | null; width_in: number | null }, o: Options) {
  const dims = p.length_in && p.width_in ? ` (${p.length_in}" x ${p.width_in}")` : "";
  const what = p.type === "tile" ? `tiles${dims}` : p.type === "carpet" ? "carpet" : `planks${dims}`;
  const dir: Record<string, string> = {
    along: ", running away from the camera",
    across: ", running left to right",
    diagonal: ", laid diagonally",
  };
  const pat: Record<string, string> = {
    straight: " in a staggered layout",
    herringbone: " in a herringbone layout",
    grid: " in a straight grid with thin grout lines",
    offset: " in an offset brick layout with thin grout lines",
  };
  const layout = p.type === "carpet" ? "" : `${pat[o.pattern ?? ""] ?? ""}${dir[o.direction ?? ""] ?? ""}`;
  return `Replace the floor in the first photo with the flooring shown in the second photo (${p.name}, ${what}${layout}). ` +
    `Keep the exact colour and pattern of the second photo. Keep the walls, furniture, lighting, shadows, camera angle and framing of the first photo unchanged. Photorealistic.` +
    (o.extra ? ` ${o.extra}` : "");
}

async function falEdit(model: string, prompt: string, imageUrls: string[], timeoutMs = 120_000): Promise<{ ok: true; image: FalImage } | { ok: false; error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://fal.run/${model}`, {
      method: "POST",
      headers: { Authorization: `Key ${FAL_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, image_urls: imageUrls, num_images: 1, output_format: "jpeg" }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `${model} ${res.status}: ${text.slice(0, 600)}` };
    const out = JSON.parse(text) as { images?: FalImage[] };
    const img = out.images?.[0];
    if (!img?.url) return { ok: false, error: `${model}: no image in response` };
    return { ok: true, image: img };
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return { ok: false, error: name === "AbortError" ? `${model}: timed out` : `${model}: ${String(e)}` };
  } finally { clearTimeout(timer); }
}

type Img = { bytes: Uint8Array; mime: string };
function b64(bytes: Uint8Array) { let s = ""; const chunk = 0x8000; for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk)); return btoa(s); }
function unb64(s: string) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }

// Google Gemini image edit (Nano Banana family), images inline.
async function googleEdit(model: string, prompt: string, images: Img[], timeoutMs = 120_000): Promise<{ ok: true; image: Img } | { ok: false; error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": GEMINI_KEY!, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }, ...images.map((im) => ({ inlineData: { mimeType: im.mime, data: b64(im.bytes) } }))] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `${model} ${res.status}: ${text.slice(0, 600)}` };
    const out = JSON.parse(text) as { candidates?: { content?: { parts?: { inlineData?: { mimeType: string; data: string }; text?: string }[] }; finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
    const parts = out.candidates?.[0]?.content?.parts ?? [];
    const img = parts.find((p) => p.inlineData?.data)?.inlineData;
    if (!img) {
      const why = out.promptFeedback?.blockReason ?? out.candidates?.[0]?.finishReason ?? parts.find((p) => p.text)?.text?.slice(0, 200) ?? "no image part";
      return { ok: false, error: `${model}: no image (${why})` };
    }
    return { ok: true, image: { bytes: unb64(img.data), mime: img.mimeType || "image/png" } };
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    return { ok: false, error: name === "AbortError" ? `${model}: timed out` : `${model}: ${String(e)}` };
  } finally { clearTimeout(timer); }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!FAL_KEY && !GEMINI_KEY) return json({ error: "No image provider key. Add GEMINI_KEY or FAL_KEY in Supabase → Edge Functions → Secrets." }, 500);

  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "Not signed in." }, 401);

  const body = await req.json().catch(() => null) as
    | { store_id?: string; product_id?: string; room_path?: string; options?: Options; lead_name?: string; lead_phone?: string; num_images?: number }
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
  const wantGoogle = String(settings.provider ?? "fal") === "google" && !!GEMINI_KEY;
  const model = wantGoogle ? String(settings.google_model ?? "gemini-nano-banana-2.1") : String(settings.model ?? "fal-ai/nano-banana-2/edit");
  const fallback = FAL_KEY && settings.fallback_model ? String(settings.fallback_model) : null; // fallback always runs on fal
  const modelCosts = (settings.model_costs ?? {}) as Record<string, number>;
  const maxImages = Math.min(4, Math.max(1, Number(settings.images_per_generation ?? 3)));
  const numImages = Math.min(maxImages, Math.max(1, Math.round(Number(body.num_images ?? settings.default_images ?? maxImages)) || maxImages));
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
    console.error("render failed", render.id, msg);
    await svc.from("credit_ledger").insert({ store_id: body.store_id, delta: credits, reason: "refund", render_id: render.id, note: msg.slice(0, 200) });
    await svc.from("renders").update({ status: "failed", error: msg.slice(0, 2000), finished_at: new Date().toISOString() }).eq("id", render.id);
    return json({ error: msg, render_id: render.id, refunded: true }, status);
  };

  try {
    const [room, swatch] = await Promise.all([
      svc.storage.from("rooms").createSignedUrl(body.room_path, 3600),
      svc.storage.from("swatches").createSignedUrl(product.swatch_path, 3600),
    ]);
    if (room.error || !room.data) return await fail("Room photo not found in storage.", 400);
    if (swatch.error || !swatch.data) return await fail("Swatch photo not found in storage.", 400);
    const urls = [room.data.signedUrl, swatch.data.signedUrl];

    // Make sure the provider will be able to fetch both images.
    for (const [label, u] of [["room photo", urls[0]], ["swatch", urls[1]]] as const) {
      const head = await fetch(u, { method: "HEAD" }).catch(() => null);
      if (!head || !head.ok) return await fail(`The ${label} could not be fetched from storage (${head?.status ?? "no response"}).`, 500);
      const ct = head.headers.get("content-type") ?? "";
      if (!/^image\/(jpeg|png|webp)/.test(ct)) return await fail(`The ${label} is ${ct || "an unknown type"}; use a JPG, PNG or WebP (iPhone HEIC photos need converting).`, 400);
    }

    // Google takes the images inline; fetch them once.
    let inline: Img[] = [];
    if (wantGoogle) {
      inline = await Promise.all(urls.map(async (u) => { const r = await fetch(u); return { bytes: new Uint8Array(await r.arrayBuffer()), mime: (r.headers.get("content-type") ?? "image/jpeg").split(";")[0] }; }));
    }
    type Got = { ok: true; image: Img; model: string } | { ok: false; error: string };
    const fromFal = async (m: string): Promise<Got> => {
      const r = await falEdit(m, prompt, urls); if (!r.ok) return r;
      const dl = await fetch(r.image.url); if (!dl.ok) return { ok: false, error: `${m}: could not download output` };
      return { ok: true, model: m, image: { bytes: new Uint8Array(await dl.arrayBuffer()), mime: r.image.content_type ?? dl.headers.get("content-type") ?? "image/jpeg" } };
    };
    // N independent single-image attempts in parallel; each falls back to fal on failure.
    const attempt = async (): Promise<Got> => {
      const a: Got = wantGoogle ? await googleEdit(model, prompt, inline).then((r) => r.ok ? { ...r, model } : r) : await fromFal(model);
      if (a.ok) return a;
      console.warn("primary failed", a.error);
      if (!fallback || fallback === model) return a;
      const b = await fromFal(fallback);
      return b.ok ? b : { ok: false, error: `${a.error} | ${b.error}` };
    };
    const results = await Promise.all(Array.from({ length: numImages }, attempt));
    const good = results.filter((r): r is { ok: true; image: Img; model: string } => r.ok);
    const errors = results.filter((r): r is { ok: false; error: string } => !r.ok).map((r) => r.error);
    if (!good.length) return await fail(`Image provider could not render this photo. ${errors[0] ?? ""}`.trim());

    const outputs: { path: string; model?: string }[] = [];
    let cost = 0;
    for (let i = 0; i < good.length; i++) {
      const g = good[i];
      const ct = g.image.mime || "image/jpeg";
      const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
      const path = `${body.store_id}/${render.id}/${i + 1}.${ext}`;
      const up = await svc.storage.from("renders").upload(path, g.image.bytes, { contentType: ct, upsert: true });
      if (!up.error) { outputs.push({ path, model: g.model }); cost += Number(modelCosts[g.model] ?? costPerImage); }
    }
    if (!outputs.length) return await fail("Could not store the generated images.");

    await svc.from("renders").update({
      status: "done", outputs, provider_cost_cents: cost, finished_at: new Date().toISOString(),
      error: errors.length ? `${errors.length} of ${numImages} attempts failed: ${errors[0].slice(0, 300)}` : null,
    }).eq("id", render.id);

    const signed = await Promise.all(outputs.map((o) => svc.storage.from("renders").createSignedUrl(o.path, 3600)));
    const balance = await svc.rpc("store_balance", { p_store: body.store_id });
    return json({
      render_id: render.id,
      outputs: outputs.map((o, i) => ({ ...o, url: signed[i].data?.signedUrl ?? null })),
      partial: errors.length ? `${good.length} of ${numImages} options rendered.` : null,
      balance: balance.data ?? null,
    });
  } catch (e) {
    return await fail(e instanceof Error ? e.message : String(e));
  }
});
