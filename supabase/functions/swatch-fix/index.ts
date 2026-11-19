// Floor Swap — swatch-fix: clean up a STORE product's swatch photo (glare, reflections, shadows) through the ChatGPT worker.
// Review first: the cleaned image is saved to a holding spot; nothing live changes until `apply`.
// POST { ids: string[], prompt? }   clean up to 3 store products, returns [{ id, name, before_url, after_url } | { id, error }]
// POST { apply: string[] }          point the product at the cleaned image (the original file is kept, so it can be put back)
// POST { revert: string[] }         point the product back at its original photo
// Auth: x-autotag-token (public.autotag_config) or a signed-in platform admin.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEEK = 7 * 24 * 3600;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const holding = (id: string) => `ai-clean/store/${id}.png`;          // catalog bucket: cleaned image waiting for review
const cleanPath = (store: string, id: string) => `${store}/${id}-clean.png`; // swatches bucket: cleaned image once applied

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

  const body = await req.json().catch(() => ({})) as { ids?: string[]; apply?: string[]; revert?: string[]; prompt?: string };

  if (body.apply?.length) {
    const out: { id: string; ok?: boolean; was?: string; now?: string; error?: string }[] = [];
    for (const id of body.apply.slice(0, 40)) {
      const { data: p } = await svc.from("products").select("id, store_id, swatch_path").eq("id", id).maybeSingle();
      if (!p) { out.push({ id, error: "Product not found." }); continue; }
      const dl = await svc.storage.from("catalog").download(holding(id));
      if (dl.error || !dl.data) { out.push({ id, error: "No cleaned image waiting." }); continue; }
      const to = cleanPath(p.store_id, id);
      const up = await svc.storage.from("swatches").upload(to, new Uint8Array(await dl.data.arrayBuffer()), { contentType: "image/png", upsert: true });
      if (up.error) { out.push({ id, error: up.error.message }); continue; }
      const { error } = await svc.from("products").update({ swatch_path: to }).eq("id", id);
      if (error) { out.push({ id, error: error.message }); continue; }
      out.push({ id, ok: true, was: p.swatch_path, now: to });
    }
    return json({ applied: out });
  }

  if (body.revert?.length) {
    const out: { id: string; ok?: boolean; now?: string; error?: string }[] = [];
    for (const id of body.revert.slice(0, 40)) {
      const { data: p } = await svc.from("products").select("id, store_id, swatch_path").eq("id", id).maybeSingle();
      if (!p) { out.push({ id, error: "Product not found." }); continue; }
      if (!p.swatch_path?.endsWith("-clean.png")) { out.push({ id, error: "Already on its original photo." }); continue; }
      const { data: files } = await svc.storage.from("swatches").list(p.store_id, { search: id });
      const orig = files?.find((f) => f.name.startsWith(id) && !f.name.includes("-clean"));
      if (!orig) { out.push({ id, error: "Original photo not found." }); continue; }
      const { error } = await svc.from("products").update({ swatch_path: `${p.store_id}/${orig.name}` }).eq("id", id);
      out.push(error ? { id, error: error.message } : { id, ok: true, now: `${p.store_id}/${orig.name}` });
    }
    return json({ reverted: out });
  }

  const ids = (body.ids ?? []).slice(0, 3);
  if (!ids.length) return json({ error: "ids required." }, 400);
  const { data: w } = await svc.from("codex_worker").select("last_seen, ok").eq("id", 1).maybeSingle();
  if (!w?.ok || !w.last_seen || Date.now() - new Date(w.last_seen).getTime() > 45_000) return json({ error: "The ChatGPT worker is not running or not logged in." }, 503);
  const { data: rows, error } = await svc.from("products").select("id, store_id, name, type, swatch_path").in("id", ids);
  if (error) return json({ error: error.message }, 500);

  const one = async (r: { id: string; store_id: string; name: string; type: string; swatch_path: string | null }) => {
    try {
      if (!r.swatch_path) throw new Error("No swatch.");
      if (r.swatch_path.endsWith("-clean.png")) throw new Error("Already using a cleaned photo; revert it first to clean again.");
      const src = await svc.storage.from("swatches").createSignedUrl(r.swatch_path, WEEK);
      if (src.error || !src.data) throw new Error("Swatch not found.");
      await svc.storage.from("catalog").remove([holding(r.id)]); // a signed upload cannot overwrite an earlier attempt
      const up = await svc.storage.from("catalog").createSignedUploadUrl(holding(r.id));
      if (up.error || !up.data) throw new Error(`Could not prepare upload (${up.error?.message ?? ""})`);
      const { data: job, error: jerr } = await svc.from("codex_jobs").insert({
        store_id: r.store_id, prompt: body.prompt ? body.prompt.replaceAll("{name}", r.name) : PROMPT(r.name, r.type),
        input_urls: [src.data.signedUrl], upload_url: up.data.signedUrl, output_path: holding(r.id),
      }).select("id").single();
      if (jerr || !job) throw new Error(`Could not queue (${jerr?.message ?? ""})`);
      const deadline = Date.now() + 120_000;
      for (;;) {
        await new Promise((res) => setTimeout(res, 2000));
        const { data: j } = await svc.from("codex_jobs").select("status, error").eq("id", job.id).maybeSingle();
        if (!j || j.status === "failed" || j.status === "cancelled") throw new Error(j?.error ?? "job lost");
        if (j.status === "done") break;
        if (Date.now() > deadline) {
          await svc.from("codex_jobs").update({ status: "cancelled", error: "swatch-fix stopped waiting", finished_at: new Date().toISOString() }).eq("id", job.id).in("status", ["pending", "running"]);
          throw new Error("timed out");
        }
      }
      const after = await svc.storage.from("catalog").createSignedUrl(holding(r.id), WEEK);
      if (after.error || !after.data) throw new Error("Cleaned image missing from storage.");
      return { id: r.id, name: r.name, before_url: src.data.signedUrl, after_url: after.data.signedUrl };
    } catch (e) {
      return { id: r.id, name: r.name, error: (e instanceof Error ? e.message : String(e)).slice(0, 600) };
    }
  };
  return json({ results: await Promise.all((rows ?? []).map(one)) });
});
