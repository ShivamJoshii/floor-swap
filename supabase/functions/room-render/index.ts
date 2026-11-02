// Floor Swap — room-render: one photorealistic room with several of the store's products in their spots
// (e.g. plank floor + backsplash tile). Built from the products' swatches; no customer photo.
// Each distinct combo (room type + product per spot) is rendered once per store and reused.
// POST { store_id, room_type, spots: { floor?: id, backsplash?: id, shower?: id, feature_wall?: id }, redo?: boolean }
// -> { id, path, url, cached }
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

// Keep in sync with web/src/lib/rooms.ts
const SCENES: Record<string, string> = {
  kitchen: "a bright, modern kitchen with an island, bar stools, pendant lights and upper and lower cabinets",
  bathroom: "a modern bathroom with a floating vanity, a large mirror and a walk-in glass shower",
  "living room": "a bright, modern open-plan living room with a sofa, a low coffee table and large windows",
  bedroom: "a calm, bright bedroom with a made bed and a bench at its foot",
  basement: "a finished basement family room with a sectional sofa, a TV wall and recessed lights",
  entryway: "a bright front entryway with a bench, coat hooks and a mirror",
  hallway: "a long, bright hallway with doors on one side and art on the wall",
  laundry: "a clean laundry room with front-load machines, a countertop and upper cabinets",
};
const SPOTS: Record<string, string> = {
  floor: "the entire floor",
  backsplash: "the kitchen backsplash (the wall between the countertop and the upper cabinets)",
  shower: "the shower walls",
  feature_wall: "one feature wall (the main wall facing the camera)",
};
const ORDER = ["floor", "backsplash", "shower", "feature_wall"];

type P = { id: string; name: string; type: string; length_in: number | null; width_in: number | null; swatch_path: string; tags: string[] | null; notes: string | null };

function material(p: P) {
  const dims = p.length_in && p.width_in ? ` (${p.length_in}" x ${p.width_in}")` : "";
  const what = p.type === "tile" ? `tile${dims}` : p.type === "carpet" ? "carpet" : p.type === "other" ? "mosaic tile" : `plank flooring${dims}`;
  const herring = /herringbone/i.test([...(p.tags ?? []), p.name, p.notes ?? ""].join(" "));
  const layout = p.type === "carpet" ? "" : herring ? ", herringbone pattern" : p.type === "plank" ? ", staggered" : ", thin tidy grout lines";
  return `${p.name} ${what}${layout}`;
}

function buildPrompt(room: string, used: [string, P][]) {
  const lines = used.map(([spot, p], i) => `- Reference image ${i + 1} = ${material(p)}. Use it on ${SPOTS[spot]}.`);
  const others = ORDER.filter((s) => !used.some(([u]) => u === s) && s !== "floor" && (room === "kitchen" || room === "laundry" ? true : s !== "backsplash"));
  return `Create a photorealistic interior design photograph of ${SCENES[room] ?? SCENES["living room"]}.\n` +
    `Finish these surfaces with the exact products in the reference images:\n${lines.join("\n")}\n` +
    `Copy each reference exactly: same colour, tone, grain or veining and pattern, at realistic scale and in correct perspective. Each product goes only on its own surface.` +
    (others.length ? ` Keep other walls plain painted drywall in a neutral colour that suits the products.` : "") +
    ` Eye-level wide shot that clearly shows every finished surface, soft natural daylight, tidy and styled like a premium home magazine. No people, no text, no logos, no watermark. Landscape 4:3.`;
}

type Img = { bytes: Uint8Array; mime: string };
function b64(bytes: Uint8Array) { let s = ""; const chunk = 0x8000; for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk)); return btoa(s); }
function unb64(s: string) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }

async function googleGen(model: string, prompt: string, refs: Img[], timeoutMs = 140_000): Promise<{ ok: true; image: Img } | { ok: false; error: string }> {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": GEMINI_KEY!, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }, ...refs.map((r) => ({ inlineData: { mimeType: r.mime, data: b64(r.bytes) } }))] }],
        generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
      }),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `${model} ${res.status}: ${text.slice(0, 400)}` };
    const out = JSON.parse(text) as { candidates?: { content?: { parts?: { inlineData?: { mimeType: string; data: string } }[] }; finishReason?: string }[] };
    const img = out.candidates?.[0]?.content?.parts?.find((x) => x.inlineData?.data)?.inlineData;
    if (!img) return { ok: false, error: `${model}: no image (${out.candidates?.[0]?.finishReason ?? "empty"})` };
    return { ok: true, image: { bytes: unb64(img.data), mime: img.mimeType || "image/png" } };
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.name === "AbortError" ? `${model}: timed out` : `${model}: ${String(e)}` };
  } finally { clearTimeout(timer); }
}

async function falGen(model: string, prompt: string, refUrls: string[], timeoutMs = 140_000): Promise<{ ok: true; image: Img } | { ok: false; error: string }> {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://fal.run/${model}`, {
      method: "POST",
      headers: { Authorization: `Key ${FAL_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, image_urls: refUrls, num_images: 1, output_format: "jpeg" }),
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

  const body = await req.json().catch(() => null) as { store_id?: string; room_type?: string; spots?: Record<string, string>; redo?: boolean } | null;
  if (!body?.store_id || !body.room_type || !SCENES[body.room_type]) return json({ error: "store_id and a valid room_type are required." }, 400);
  const spots = Object.fromEntries(Object.entries(body.spots ?? {}).filter(([k, v]) => SPOTS[k] && typeof v === "string" && v));
  if (!Object.keys(spots).length) return json({ error: "Pick at least one product." }, 400);

  const svc = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data: member } = await svc.from("store_members").select("role").eq("store_id", body.store_id).eq("user_id", user.id).maybeSingle();
  if (!member) return json({ error: "You are not a member of this store." }, 403);

  const used = ORDER.filter((s) => spots[s]).map((s) => [s, spots[s]] as [string, string]);
  const comboKey = [body.room_type, ...used.map(([s, id]) => `${s}=${id}`)].join("|");

  const { data: existing } = await svc.from("room_renders").select("id, path, status, updated_at").eq("store_id", body.store_id).eq("combo_key", comboKey).maybeSingle();
  if (existing?.status === "done" && existing.path && !body.redo) {
    const s = await svc.storage.from("renders").createSignedUrl(existing.path, 3600);
    return json({ id: existing.id, path: existing.path, url: s.data?.signedUrl ?? null, cached: true });
  }
  if (existing?.status === "running" && Date.now() - new Date(existing.updated_at).getTime() < 4 * 60_000) {
    return json({ error: "This room is already being made. Try again in a minute." }, 409);
  }

  const { data: prods } = await svc.from("products").select("id, name, type, length_in, width_in, swatch_path, tags, notes").eq("store_id", body.store_id).in("id", used.map(([, id]) => id));
  const byId = new Map(((prods ?? []) as P[]).map((p) => [p.id, p]));
  const withP = used.map(([s, id]) => [s, byId.get(id)] as [string, P | undefined]);
  if (withP.some(([, p]) => !p)) return json({ error: "One of the products wasn't found." }, 404);
  const pairs = withP as [string, P][];

  const { data: settingsRows } = await svc.from("app_settings").select("key, value");
  const settings: Record<string, unknown> = {}; for (const r of settingsRows ?? []) settings[r.key] = r.value;
  const wantGoogle = String(settings.provider ?? "fal") === "google" && !!GEMINI_KEY;
  const primary = wantGoogle ? String(settings.google_model ?? "gemini-nano-banana-2.1") : String(settings.model ?? "fal-ai/nano-banana-2/edit");
  const fallback = FAL_KEY ? String(settings.fallback_model ?? settings.model ?? "fal-ai/nano-banana-2/edit") : null;

  const row = { store_id: body.store_id, room_type: body.room_type, spots, combo_key: comboKey, status: "running", error: null, created_by: user.id, updated_at: new Date().toISOString() };
  const { data: rr, error: rerr } = await svc.from("room_renders").upsert(row, { onConflict: "store_id,combo_key" }).select("id").single();
  if (rerr || !rr) return json({ error: "Could not start: " + (rerr?.message ?? "") }, 500);

  try {
    const signed = await Promise.all(pairs.map(([, p]) => svc.storage.from("swatches").createSignedUrl(p.swatch_path, 3600)));
    if (signed.some((s) => s.error || !s.data)) throw new Error("A product's swatch is missing.");
    const urls = signed.map((s) => s.data!.signedUrl);
    const prompt = buildPrompt(body.room_type, pairs);
    let r: { ok: true; image: Img } | { ok: false; error: string }; let model = primary;
    if (wantGoogle) {
      const refs = await Promise.all(urls.map(async (u) => { const x = await fetch(u); return { bytes: new Uint8Array(await x.arrayBuffer()), mime: (x.headers.get("content-type") ?? "image/jpeg").split(";")[0] }; }));
      r = await googleGen(primary, prompt, refs);
      if (!r.ok && fallback) { console.warn("google failed", r.error); model = fallback; r = await falGen(fallback, prompt, urls); }
    } else r = await falGen(primary, prompt, urls);
    if (!r.ok) throw new Error(r.error);
    const ext = r.image.mime.includes("png") ? "png" : r.image.mime.includes("webp") ? "webp" : "jpg";
    // New file name on every render so a redo never shows a cached old image.
    const path = `${body.store_id}/rooms/${rr.id}-${Date.now()}.${ext}`;
    const up = await svc.storage.from("renders").upload(path, r.image.bytes, { contentType: r.image.mime });
    if (up.error) throw new Error(up.error.message);
    await svc.from("room_renders").update({ path, status: "done", error: null, model, updated_at: new Date().toISOString() }).eq("id", rr.id);
    const s = await svc.storage.from("renders").createSignedUrl(path, 3600);
    return json({ id: rr.id, path, url: s.data?.signedUrl ?? null, cached: false });
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    // A failed redo keeps the previous good image.
    await svc.from("room_renders").update(existing?.path ? { status: "done", error: msg, updated_at: new Date().toISOString() } : { status: "failed", error: msg, updated_at: new Date().toISOString() }).eq("id", rr.id);
    return json({ error: `Couldn't make the photo: ${msg}` }, 502);
  }
});
