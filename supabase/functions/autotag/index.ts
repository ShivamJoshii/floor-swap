// Floor Swap — autotag: fills colour, shade, vibe, look tags, rooms and surfaces for products and supplier catalogue rows
// that have never been tagged. A scheduled sweep calls it every few minutes, so anything imported any way gets tagged.
// POST { limit?: number, table?: "products" | "supplier_products", ids?: string[], force?: boolean }
// Auth: the sweep's x-autotag-token header (public.autotag_config), or a signed-in platform admin.
// Returns { tagged: [...], failed: [...], remaining: { products, supplier_products }, model }
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_KEY = Deno.env.get("GEMINI_KEY");
const FAL_KEY = Deno.env.get("FAL_KEY");
const MAX_TRIES = 3;
const PARALLEL = 4;

const HUES = ["white", "grey", "beige", "tan", "brown", "black", "blue", "green", "multi"];
const TONES = ["light", "medium", "dark"];
const VIBES = ["modern", "warm", "luxury", "minimal", "rustic", "classic", "bold", "natural"];
const LOOKS = ["marble look", "wood look", "stone look", "concrete look", "terrazzo", "patterned", "plain"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-autotag-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Table = "products" | "supplier_products";
type Row = {
  id: string; name: string; type: string; collection: string | null; length_in: number | null; width_in: number | null; swatch_path: string | null;
  colour_family: string | null; tone: string | null; hue: string | null; surfaces: string[] | null; rooms: string[] | null; tags: string[] | null;
  tag_tries: number; supplier_product_id?: string | null;
};
type Look = { hue: string; tone: string; vibes: string[]; looks: string[] };

const PROMPT = (r: Row) =>
  `This photo is a flat swatch of one flooring or wall product: "${r.name}" (${r.type}${r.collection ? ", " + r.collection : ""}). Describe how the SURFACE looks. Ignore glare, shadows, labels and anything around the product.\n` +
  `hue: the dominant colour. white, grey, beige (pale cream or sand), tan (golden, honey or caramel mid-tone), brown, black, blue, green, or multi (no single dominant colour, or a strong multi-colour pattern).\n` +
  `tone: overall lightness. light, medium or dark.\n` +
  `vibes: the 1 or 2 that fit best. modern (clean, contemporary, crisp, cool or concrete-like), warm (inviting warm undertones: honey, oak, cream, beige), ` +
  `luxury (polished marble, bold or gold veining, glossy, dramatic), minimal (plain, very little pattern, uniform), rustic (weathered, knotty, distressed, reclaimed), ` +
  `classic (traditional and timeless: mid-tone oak, travertine, soft classic marble), bold (strong pattern, colour or contrast; a statement piece), natural (organic wood or stone character, earthy, matte).\n` +
  `looks: 0 to 2 that clearly apply. marble look, wood look, stone look, concrete look, terrazzo, patterned (geometric or decorative print), plain (no visible pattern).`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    hue: { type: "STRING", enum: HUES },
    tone: { type: "STRING", enum: TONES },
    vibes: { type: "ARRAY", items: { type: "STRING", enum: VIBES }, minItems: 1, maxItems: 2 },
    looks: { type: "ARRAY", items: { type: "STRING", enum: LOOKS }, maxItems: 2 },
  },
  required: ["hue", "tone", "vibes", "looks"],
};

function b64(bytes: Uint8Array) { let s = ""; const chunk = 0x8000; for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk)); return btoa(s); }

function clean(x: unknown): Look | null {
  const o = x as Partial<Look> | null;
  if (!o || !HUES.includes(String(o.hue)) || !TONES.includes(String(o.tone))) return null;
  const vibes = [...new Set((o.vibes ?? []).filter((v) => VIBES.includes(v)))].slice(0, 2);
  if (!vibes.length) return null;
  return { hue: String(o.hue), tone: String(o.tone), vibes, looks: [...new Set((o.looks ?? []).filter((v) => LOOKS.includes(v)))].slice(0, 2) };
}

async function withTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fn(ctrl.signal); } finally { clearTimeout(t); }
}

/** Ask Google. Tries each model id until one exists; remembers the one that worked for the rest of this request. */
let workingModel: string | null = null;
async function googleLook(models: string[], prompt: string, bytes: Uint8Array, mime: string): Promise<Look> {
  let last = "no model tried";
  for (const model of workingModel ? [workingModel] : models) {
    const res = await withTimeout(45_000, (signal) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST", signal,
      headers: { "x-goog-api-key": GEMINI_KEY!, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: mime, data: b64(bytes) } }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json", responseSchema: SCHEMA },
      }),
    }));
    const text = await res.text();
    if (res.status === 404 || (res.status === 400 && /not found|not supported|unknown model/i.test(text))) { last = `${model} ${res.status}`; continue; }
    if (!res.ok) throw new Error(`${model} ${res.status}: ${text.slice(0, 300)}`);
    const out = JSON.parse(text) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const raw = out.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const look = clean(JSON.parse(raw || "null"));
    if (!look) throw new Error(`${model}: unusable answer ${raw.slice(0, 200)}`);
    workingModel = model;
    return look;
  }
  throw new Error(`No usable Google model (${last}). Set app_settings.tag_model.`);
}

/** Fallback when there is no Google key: fal's vision LLM endpoint. */
async function falLook(model: string, prompt: string, imageUrl: string): Promise<Look> {
  const res = await withTimeout(60_000, (signal) => fetch("https://fal.run/fal-ai/any-llm/vision", {
    method: "POST", signal,
    headers: { Authorization: `Key ${FAL_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, image_url: imageUrl, prompt: prompt + `\nAnswer with JSON only: {"hue": "...", "tone": "...", "vibes": ["..."], "looks": ["..."]}` }),
  }));
  const text = await res.text();
  if (!res.ok) throw new Error(`fal ${res.status}: ${text.slice(0, 300)}`);
  const raw = String((JSON.parse(text) as { output?: string }).output ?? "");
  const m = raw.match(/\{[\s\S]*\}/);
  const look = clean(m ? JSON.parse(m[0]) : null);
  if (!look) throw new Error(`fal: unusable answer ${raw.slice(0, 200)}`);
  return look;
}

/** Default surfaces/rooms/tags from name, type and size. Mirrors suggestTags in web/src/lib/colour.ts. */
function suggest(p: Row) {
  const n = p.name.toLowerCase(), cat = (p.collection ?? "").toLowerCase();
  let surfaces = new Set<string>(["floor"]); const rooms = new Set<string>(); const tags = new Set<string>();
  if (p.type === "plank") { ["living room", "bedroom", "kitchen", "basement", "hallway"].forEach((x) => rooms.add(x)); tags.add("plank"); }
  if (p.type === "carpet") { ["bedroom", "basement", "living room", "stairs"].forEach((x) => rooms.add(x)); tags.add("carpet"); }
  if (p.type === "other" || /mosaic/.test(n) || /mosaic/.test(cat)) { surfaces = new Set(["wall", "backsplash", "shower"]); rooms.add("kitchen"); rooms.add("bathroom"); tags.add("mosaic"); }
  if (p.type === "tile") {
    ["kitchen", "bathroom", "entryway", "laundry"].forEach((x) => rooms.add(x));
    const L = Math.max(p.length_in ?? 0, p.width_in ?? 0), W = Math.min(p.length_in ?? 0, p.width_in ?? 0); const small = L > 0 && L <= 12 && W <= 6;
    if (small || /\bsubway\b|\bripple\b|\bdecor\b|\bdec\b/.test(n)) { surfaces.add("wall"); surfaces.add("backsplash"); }
    if (small && !/porcelain|through-body/.test(n)) surfaces.delete("floor");
    if (L >= 24) { surfaces.add("wall"); rooms.add("living room"); }
    if (/polished|glossy/.test(n)) tags.add("polished");
    if (/marble|calacatta|carrara|statuario|taj mahal/.test(n) || /marble/.test(cat)) tags.add("marble look");
    if (/wood|oak|plank/.test(n)) tags.add("wood look");
    if (/stone|slate|travertine|concrete|cement/.test(n)) tags.add("stone look");
    if (/versace/.test(n) || /versace/.test(cat)) tags.add("designer");
    if (/hex/.test(n)) tags.add("hexagon");
    if (/herringbone|chevron/.test(n)) tags.add("herringbone");
  }
  if (p.type === "plank") {
    if (/herringbone/.test(n) || /herringbone/.test(cat)) tags.add("herringbone");
    if (/laminate/.test(cat)) tags.add("laminate");
    if (/hardwood/.test(cat)) tags.add("hardwood");
    if (/vinyl|spc/.test(cat)) tags.add("vinyl");
    for (const sp of ["oak", "walnut", "hickory", "maple"]) if (n.includes(sp)) tags.add(sp);
  }
  return { surfaces: [...surfaces].sort(), rooms: [...rooms].sort(), tags: [...tags] };
}

function patch(r: Row, look: Look | null) {
  const sug = suggest(r);
  const isDefaultSurface = !r.surfaces?.length || (r.surfaces.length === 1 && r.surfaces[0] === "floor");
  const tags = [...new Set([...(r.tags ?? []), ...sug.tags, ...(look?.looks ?? []).filter((l) => l !== "plain")])].sort();
  const out: Record<string, unknown> = {
    surfaces: isDefaultSurface ? sug.surfaces : r.surfaces,
    rooms: r.rooms?.length ? r.rooms : sug.rooms,
    tags, tagged_at: new Date().toISOString(), tag_error: null,
  };
  if (look) {
    // Colour and shade a person (or the in-app classifier) already set are kept.
    const hue = r.hue ?? look.hue, tone = r.tone ?? look.tone;
    Object.assign(out, { hue, tone, vibes: look.vibes, colour_family: r.colour_family ?? `${tone} ${hue}` });
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const svc = createClient(SUPABASE_URL, SERVICE_KEY);

  // Who is calling: the scheduled sweep (token) or a signed-in platform admin.
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
  if (!GEMINI_KEY && !FAL_KEY) return json({ error: "No AI key (GEMINI_KEY or FAL_KEY)." }, 500);

  const body = await req.json().catch(() => ({})) as { limit?: number; table?: Table; ids?: string[]; force?: boolean };
  const limit = Math.min(40, Math.max(1, Number(body.limit ?? 12)));
  const { data: settingsRows } = await svc.from("app_settings").select("key, value").in("key", ["tag_model", "tag_fal_model"]);
  const settings: Record<string, unknown> = {}; for (const s of settingsRows ?? []) settings[s.key] = s.value;
  const googleModels = [...new Set([settings.tag_model ? String(settings.tag_model) : "", "gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash"].filter(Boolean))];
  const falModel = String(settings.tag_fal_model ?? "google/gemini-flash-1.5");

  const cols = "id, name, type, collection, length_in, width_in, swatch_path, colour_family, tone, hue, surfaces, rooms, tags, tag_tries";
  const pick = async (table: Table, n: number): Promise<Row[]> => {
    let q = svc.from(table).select(table === "products" ? cols + ", supplier_product_id" : cols);
    if (body.ids?.length) q = q.in("id", body.ids.slice(0, 40));
    if (!body.force) q = q.is("tagged_at", null).lt("tag_tries", MAX_TRIES);
    const { data, error } = await q.order("created_at").limit(n);
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as Row[];
  };

  const one = async (table: Table, r: Row): Promise<{ table: Table; id: string; name: string; hue?: string; tone?: string; vibes?: string[]; copied?: boolean; error?: string }> => {
    try {
      let look: Look | null = null; let copied = false;
      // A store product added from the catalogue takes the catalogue row's answer, so the two always agree and nothing is paid for twice.
      if (table === "products" && r.supplier_product_id) {
        const { data: sp } = await svc.from("supplier_products").select("hue, tone, vibes, tags, tagged_at").eq("id", r.supplier_product_id).maybeSingle();
        if (sp?.tagged_at && sp.hue && sp.tone && sp.vibes?.length) { look = { hue: sp.hue, tone: sp.tone, vibes: sp.vibes, looks: (sp.tags ?? []).filter((t: string) => LOOKS.includes(t)) }; copied = true; }
      }
      if (!look && r.swatch_path) {
        const bucket = table === "products" ? "swatches" : "catalog";
        const prompt = PROMPT(r);
        if (GEMINI_KEY) {
          const dl = await svc.storage.from(bucket).download(r.swatch_path);
          if (dl.error || !dl.data) throw new Error("Swatch not found.");
          look = await googleLook(googleModels, prompt, new Uint8Array(await dl.data.arrayBuffer()), dl.data.type || "image/jpeg");
        } else {
          const signed = await svc.storage.from(bucket).createSignedUrl(r.swatch_path, 600);
          if (signed.error || !signed.data) throw new Error("Swatch not found.");
          look = await falLook(falModel, prompt, signed.data.signedUrl);
        }
      }
      const p = patch(r, look);
      if (!look) p.tag_error = "No swatch image; tagged from name and size only.";
      const { error } = await svc.from(table).update(p).eq("id", r.id);
      if (error) throw new Error(error.message);
      return { table, id: r.id, name: r.name, hue: p.hue as string | undefined, tone: p.tone as string | undefined, vibes: p.vibes as string[] | undefined, copied };
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 400);
      await svc.from(table).update({ tag_error: msg, tag_tries: r.tag_tries + 1 }).eq("id", r.id);
      return { table, id: r.id, name: r.name, error: msg };
    }
  };

  try {
    // Catalogue rows first, so store products added from them can copy the result.
    const todo: [Table, Row][] = [];
    for (const table of (body.table ? [body.table] : ["supplier_products", "products"]) as Table[]) {
      if (todo.length >= limit) break;
      for (const r of await pick(table, limit - todo.length)) todo.push([table, r]);
    }
    const results: Awaited<ReturnType<typeof one>>[] = [];
    for (let i = 0; i < todo.length; i += PARALLEL) results.push(...await Promise.all(todo.slice(i, i + PARALLEL).map(([t, r]) => one(t, r))));

    const left = async (table: Table, c: SupabaseClient) => (await c.from(table).select("id", { count: "exact", head: true }).is("tagged_at", null).lt("tag_tries", MAX_TRIES)).count ?? 0;
    return json({
      tagged: results.filter((r) => !r.error), failed: results.filter((r) => r.error),
      remaining: { products: await left("products", svc), supplier_products: await left("supplier_products", svc) },
      model: workingModel ?? (GEMINI_KEY ? null : falModel),
    });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
