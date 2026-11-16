// Floor Swap — swatch-clean: AI clean-up of a catalogue swatch photo (glare, reflections, shadows), for review before it replaces the original.
// The cleaned image is saved next to the catalogue as ai-clean/<supplier_product_id>.<ext>; nothing live changes until `apply`.
// POST { ids: string[], prompt? }   clean up to 3 catalogue swatches, returns [{ id, name, path, url } | { id, error }]
// POST { apply: string[] }          make the cleaned image the catalogue swatch (and the swatch of store products added from it)
// Auth: x-autotag-token (public.autotag_config) or a signed-in platform admin.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_KEY = Deno.env.get("GEMINI_KEY");

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function b64(bytes: Uint8Array) { let s = ""; const chunk = 0x8000; for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk)); return btoa(s); }
function unb64(s: string) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }

const PROMPT = (name: string, type: string) =>
  `This is a phone photo of one ${type === "plank" ? "flooring plank" : "tile"} sample ("${name}") on a showroom rack. ` +
  `The photo is spoiled by things that are NOT part of the product: reflections of the room on its surface (dark silhouettes of a person or phone, shelves, furniture, windows, ceiling lights), glare streaks, hot spots, shadows and uneven lighting. ` +
  `Re-create this exact product as a manufacturer's catalogue swatch: shot straight-on under perfectly even, diffuse studio light, with no reflections, no glare and no shadows anywhere. ` +
  `Rebuild the areas hidden by reflections or shadows so the base colour is uniform across the whole surface and the veining, grain or pattern continues naturally through them. ` +
  `Judge the true base colour from the cleanest, least reflective area. Keep the real veins, grain and pattern where they are, with the same thickness and colour; do not add new ones. ` +
  `The surface fills the frame edge to edge, same proportions as the photo. No text, no border, no background.`;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const svc = createClient(SUPABASE_URL, SERVICE_KEY);
  const token = req.headers.get("x-autotag-token");
  let allowed = false;
  if (token) {
    const { data: cfg } = await svc.from("autotag_config").select("token").maybeSingle();
    allowed = !!cfg?.token && cfg.token === token;
  } else if (req.headers.get("Authorization")) {
    const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: req.headers.get("Authorization")! } } });
    const { data: { user } } = await userClient.auth.getUser();
    if (user) { const { data: adm } = await svc.from("platform_admins").select("user_id").eq("user_id", user.id).maybeSingle(); allowed = !!adm; }
  }
  if (!allowed) return json({ error: "Not allowed." }, 403);

  const body = await req.json().catch(() => ({})) as { ids?: string[]; apply?: string[]; model?: string; prompt?: string };

  if (body.apply?.length) {
    const out: { id: string; ok?: boolean; products?: number; error?: string }[] = [];
    for (const id of body.apply.slice(0, 40)) {
      const { data: files } = await svc.storage.from("catalog").list("ai-clean", { search: id });
      const f = files?.find((x) => x.name.startsWith(id));
      if (!f) { out.push({ id, error: "No cleaned image." }); continue; }
      const path = `ai-clean/${f.name}`;
      const dl = await svc.storage.from("catalog").download(path);
      if (dl.error || !dl.data) { out.push({ id, error: "Cleaned image not readable." }); continue; }
      const { error } = await svc.from("supplier_products").update({ swatch_path: path }).eq("id", id);
      if (error) { out.push({ id, error: error.message }); continue; }
      // Store products added from this catalogue row keep their own copy of the swatch: overwrite it in place.
      const { data: prods } = await svc.from("products").select("id, swatch_path").eq("supplier_product_id", id);
      let n = 0; const bytes = new Uint8Array(await dl.data.arrayBuffer());
      for (const p of prods ?? []) {
        if (!p.swatch_path) continue;
        const up = await svc.storage.from("swatches").upload(p.swatch_path, bytes, { contentType: dl.data.type || "image/png", upsert: true });
        if (!up.error) n++;
      }
      out.push({ id, ok: true, products: n });
    }
    return json({ applied: out });
  }

  if (!GEMINI_KEY) return json({ error: "No GEMINI_KEY." }, 500);
  const ids = (body.ids ?? []).slice(0, 3);
  if (!ids.length) return json({ error: "ids required." }, 400);
  const { data: s } = await svc.from("app_settings").select("value").eq("key", "google_model").maybeSingle();
  const model = body.model ?? String(s?.value ?? "gemini-3-pro-image");
  const { data: rows, error } = await svc.from("supplier_products").select("id, name, type, swatch_path").in("id", ids);
  if (error) return json({ error: error.message }, 500);

  const one = async (r: { id: string; name: string; type: string; swatch_path: string | null }) => {
    try {
      if (!r.swatch_path) throw new Error("No swatch.");
      const dl = await svc.storage.from("catalog").download(r.swatch_path);
      if (dl.error || !dl.data) throw new Error("Swatch not found.");
      const bytes = new Uint8Array(await dl.data.arrayBuffer());
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 110_000);
      let text = "", status = 0;
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST", signal: ctrl.signal,
          headers: { "x-goog-api-key": GEMINI_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: body.prompt ? body.prompt.replaceAll("{name}", r.name) : PROMPT(r.name, r.type) }, { inlineData: { mimeType: dl.data.type || "image/jpeg", data: b64(bytes) } }] }],
            generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
          }),
        });
        status = res.status; text = await res.text();
      } finally { clearTimeout(timer); }
      if (status < 200 || status >= 300) throw new Error(`${model} ${status}: ${text.slice(0, 500)}`);
      const out = JSON.parse(text) as { candidates?: { content?: { parts?: { inlineData?: { mimeType: string; data: string } }[] }; finishReason?: string }[] };
      const img = out.candidates?.[0]?.content?.parts?.find((x) => x.inlineData?.data)?.inlineData;
      if (!img) throw new Error(`${model}: no image (${out.candidates?.[0]?.finishReason ?? "empty"})`);
      const mime = img.mimeType || "image/png";
      const path = `ai-clean/${r.id}.${mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg"}`;
      const up = await svc.storage.from("catalog").upload(path, unb64(img.data), { contentType: mime, upsert: true });
      if (up.error) throw new Error(up.error.message);
      const signed = await svc.storage.from("catalog").createSignedUrl(path, 6 * 3600);
      return { id: r.id, name: r.name, path, url: signed.data?.signedUrl ?? null };
    } catch (e) {
      return { id: r.id, name: r.name, error: (e instanceof Error ? e.message : String(e)).slice(0, 600) };
    }
  };
  return json({ model, results: await Promise.all((rows ?? []).map(one)) });
});
