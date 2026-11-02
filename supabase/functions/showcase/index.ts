// Floor Swap — showcase: one styled room photo per product, made from its swatch alone.
// Used on builder sheets (builders have no room photo of their own). Made once per product, then reused.
// POST { store_id, product_ids?: string[], missing?: boolean, limit?: number }
//   product_ids: make these (skips ones already done unless force)
//   missing: pick up to `limit` products in the store that have no showcase yet
// Returns { done: [{id, path}], failed: [{id, error}], remaining }
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const FAL_KEY = Deno.env.get("FAL_KEY");
const GEMINI_KEY = Deno.env.get("GEMINI_KEY");
const PER_CALL = 3; // parallel renders per request; the client loops for more

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type P = { id: string; name: string; type: string; length_in: number | null; width_in: number | null; swatch_path: string; surfaces: string[] | null; rooms: string[] | null; tags: string[] | null; notes: string | null };

const SCENES: Record<string, string> = {
  "living room": "a bright, modern open-plan living room with a sofa, a low coffee table, a rug pulled back to show the floor, and large windows",
  kitchen: "a modern kitchen with an island, bar stools and pendant lights",
  bathroom: "a modern bathroom with a freestanding tub, a floating vanity and a walk-in shower",
  bedroom: "a calm, bright bedroom with a made bed and a bench at its foot",
  basement: "a finished basement family room with a sectional sofa and recessed lights",
  entryway: "a bright front entryway with a bench, a few coat hooks and a mirror",
  hallway: "a long, bright hallway with doors on one side and art on the wall",
  laundry: "a clean laundry room with front-load machines and a countertop",
};

function buildPrompt(p: P) {
  const dims = p.length_in && p.width_in ? ` (${p.length_in}" x ${p.width_in}")` : "";
  const what = p.type === "tile" ? `tiles${dims}` : p.type === "carpet" ? "carpet" : p.type === "other" ? "mosaic tile" : `planks${dims}`;
  const rooms = (p.rooms ?? []).filter((r) => SCENES[r]);
  const fallback = p.type === "carpet" ? "bedroom" : p.type === "tile" ? "kitchen" : "living room";
  const room = p.type === "plank" && rooms.includes("living room") ? "living room" : (rooms[0] ?? fallback);
  const surfaces = p.surfaces ?? ["floor"];
  const onWall = !surfaces.includes("floor") && surfaces.length > 0;
  const herring = /herringbone/i.test([...(p.tags ?? []), p.name, p.notes ?? ""].join(" "));
  const layout = p.type === "carpet" ? "" : herring ? " laid in a herringbone pattern" : p.type === "plank" ? " in a natural staggered layout" : " with thin, tidy grout lines";
  const target = onWall
    ? (room === "bathroom" ? "the shower walls" : room === "kitchen" ? "the kitchen backsplash" : "one feature wall")
    : "the entire floor";
  return `Create a photorealistic interior design photograph of ${room === "kitchen" || room === "bathroom" ? "" : "a home's "}${SCENES[room]}. ` +
    `${target[0].toUpperCase()}${target.slice(1)} is finished with the ${what} shown in the reference photo${layout}. ` +
    `Copy the reference exactly: same colour, tone, grain or veining and pattern, at realistic scale and in correct perspective, so it is clearly this exact product (${p.name}). ` +
    `Eye-level wide shot that shows plenty of the ${onWall ? "wall" : "floor"}, soft natural daylight, tidy and styled like a premium flooring catalogue. ` +
    `No people, no text, no logos, no watermark. Landscape 4:3.`;
}

type Img = { bytes: Uint8Array; mime: string };
function b64(bytes: Uint8Array) { let s = ""; const chunk = 0x8000; for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk)); return btoa(s); }
function unb64(s: string) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }

async function googleGen(model: string, prompt: string, ref: Img, timeoutMs = 120_000): Promise<{ ok: true; image: Img } | { ok: false; error: string }> {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": GEMINI_KEY!, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: ref.mime, data: b64(ref.bytes) } }] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `${model} ${res.status}: ${text.slice(0, 400)}` };
    const out = JSON.parse(text) as { candidates?: { content?: { parts?: { inlineData?: { mimeType: string; data: string }; text?: string }[] }; finishReason?: string }[] };
    const img = out.candidates?.[0]?.content?.parts?.find((x) => x.inlineData?.data)?.inlineData;
    if (!img) return { ok: false, error: `${model}: no image (${out.candidates?.[0]?.finishReason ?? "empty"})` };
    return { ok: true, image: { bytes: unb64(img.data), mime: img.mimeType || "image/png" } };
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.name === "AbortError" ? `${model}: timed out` : `${model}: ${String(e)}` };
  } finally { clearTimeout(timer); }
}

async function falGen(model: string, prompt: string, refUrl: string, timeoutMs = 120_000): Promise<{ ok: true; image: Img } | { ok: false; error: string }> {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://fal.run/${model}`, {
      method: "POST",
      headers: { Authorization: `Key ${FAL_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, image_urls: [refUrl], num_images: 1, output_format: "jpeg" }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `${model} ${res.status}: ${text.slice(0, 400)}` };
    const url = (JSON.parse(text) as { images?: { url: string }[] }).images?.[0]?.url;
    if (!url) return { ok: false, error: `${model}: no image` };
    const dl = await fetch(url); if (!dl.ok) return { ok: false, error: `${model}: download failed` };
    return { ok: true, image: { bytes: new Uint8Array(await dl.arrayBuffer()), mime: dl.headers.get("content-type") ?? "image/jpeg" } };
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.name === "AbortError" ? `${model}: timed out` : `${model}: ${String(e)}` };
  } finally { clearTimeout(timer); }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!FAL_KEY && !GEMINI_KEY) return json({ error: "No image provider key (GEMINI_KEY or FAL_KEY)." }, 500);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: "Not signed in." }, 401);

  const body = await req.json().catch(() => null) as { store_id?: string; product_ids?: string[]; missing?: boolean; limit?: number; force?: boolean } | null;
  if (!body?.store_id) return json({ error: "store_id is required." }, 400);
  const svc = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: member } = await svc.from("store_members").select("role").eq("store_id", body.store_id).eq("user_id", user.id).maybeSingle();
  if (!member) return json({ error: "You are not a member of this store." }, 403);

  const cols = "id, name, type, length_in, width_in, swatch_path, surfaces, rooms, tags, notes";
  const limit = Math.min(PER_CALL, Math.max(1, Number(body.limit ?? PER_CALL)));
  // Anything stuck in "running" for 10+ minutes is treated as failed and retried.
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  let q = svc.from("products").select(cols).eq("store_id", body.store_id).eq("active", true);
  if (body.product_ids?.length) q = q.in("id", body.product_ids.slice(0, 50));
  // Explicit ids retry earlier failures; the "all missing" sweep skips them so it can't loop on a bad swatch.
  if (!body.force) q = q.is("showcase_path", null).or(body.product_ids?.length
    ? `showcase_status.is.null,showcase_status.eq.failed,and(showcase_status.eq.running,showcase_updated_at.lt.${stale})`
    : `showcase_status.is.null,and(showcase_status.eq.running,showcase_updated_at.lt.${stale})`);
  const { data: picked, error: perr } = await q.order("created_at").limit(limit);
  if (perr) return json({ error: perr.message }, 500);
  const todo = (picked ?? []) as P[];

  const { data: settingsRows } = await svc.from("app_settings").select("key, value");
  const settings: Record<string, unknown> = {}; for (const r of settingsRows ?? []) settings[r.key] = r.value;
  const wantGoogle = String(settings.provider ?? "fal") === "google" && !!GEMINI_KEY;
  const primary = wantGoogle ? String(settings.google_model ?? "gemini-nano-banana-2.1") : String(settings.model ?? "fal-ai/nano-banana-2/edit");
  const fallback = FAL_KEY ? String(settings.fallback_model ?? settings.model ?? "fal-ai/nano-banana-2/edit") : null;

  if (todo.length) await svc.from("products").update({ showcase_status: "running", showcase_error: null, showcase_updated_at: new Date().toISOString() }).in("id", todo.map((p) => p.id));

  const one = async (p: P): Promise<{ id: string; path?: string; error?: string }> => {
    try {
      const signed = await svc.storage.from("swatches").createSignedUrl(p.swatch_path, 3600);
      if (signed.error || !signed.data) throw new Error("Swatch not found.");
      const prompt = buildPrompt(p);
      let r: { ok: true; image: Img } | { ok: false; error: string };
      if (wantGoogle) {
        const s = await fetch(signed.data.signedUrl);
        r = await googleGen(primary, prompt, { bytes: new Uint8Array(await s.arrayBuffer()), mime: (s.headers.get("content-type") ?? "image/jpeg").split(";")[0] });
        if (!r.ok && fallback) { console.warn("google failed", r.error); r = await falGen(fallback, prompt, signed.data.signedUrl); }
      } else r = await falGen(primary, prompt, signed.data.signedUrl);
      if (!r.ok) throw new Error(r.error);
      const ext = r.image.mime.includes("png") ? "png" : r.image.mime.includes("webp") ? "webp" : "jpg";
      const path = `${body.store_id}/showcase/${p.id}.${ext}`;
      const up = await svc.storage.from("renders").upload(path, r.image.bytes, { contentType: r.image.mime, upsert: true });
      if (up.error) throw new Error(up.error.message);
      await svc.from("products").update({ showcase_path: path, showcase_status: "done", showcase_error: null, showcase_updated_at: new Date().toISOString() }).eq("id", p.id);
      return { id: p.id, path };
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      await svc.from("products").update({ showcase_status: "failed", showcase_error: msg, showcase_updated_at: new Date().toISOString() }).eq("id", p.id);
      return { id: p.id, error: msg };
    }
  };
  const results = await Promise.all(todo.map(one));

  let rq = svc.from("products").select("id", { count: "exact", head: true }).eq("store_id", body.store_id).eq("active", true).is("showcase_path", null);
  if (body.product_ids?.length) rq = rq.in("id", body.product_ids.slice(0, 50));
  else rq = rq.or("showcase_status.is.null,showcase_status.neq.failed");
  const { count } = await rq;
  return json({
    done: results.filter((r) => r.path).map((r) => ({ id: r.id, path: r.path })),
    failed: results.filter((r) => r.error).map((r) => ({ id: r.id, error: r.error })),
    remaining: count ?? 0,
  });
});
