// Floor Swap — storefront: public product feed for a store's own website.
// GET ?slug=<stores.web_slug>   (deploy with verify_jwt = false)
// Returns the store's active products that have "show on website" on, in the shape the website already reads:
//   { site, products, imagesByProduct, categories }
// Photos: the swatches and renders buckets are private, so each published photo is copied into the public
// `storefront` bucket (a new copy whenever the photo changes) and photos no longer published are removed.
// Never returned: prices, notes, supplier details.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const svc = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const BUCKET = "storefront";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, OPTIONS" };
const json = (body: unknown, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": cache } });

type Row = {
  store_id: string; id: string; name: string; sku: string | null; type: string; length_in: number | null; width_in: number | null; finish: string | null;
  colour_family: string | null; hue: string | null; tone: string | null; collection: string | null; tags: string[] | null; rooms: string[] | null; vibes: string[] | null; surfaces: string[] | null;
  swatch_path: string | null; swatch_ver: number | null; showcase_path: string | null; showcase_ver: number | null;
};

// One category per product, first match wins. Order here is the order on the site.
const CATEGORIES: { slug: string; name: string; match: (r: Row) => boolean }[] = [
  { slug: "marble-look", name: "Marble Look", match: (r) => r.type !== "plank" && has(r, "marble look") },
  { slug: "stone-look", name: "Stone Look", match: (r) => r.type !== "plank" && has(r, "stone look") },
  { slug: "concrete-look", name: "Concrete Look", match: (r) => r.type !== "plank" && has(r, "concrete look") },
  { slug: "terrazzo", name: "Terrazzo", match: (r) => r.type !== "plank" && has(r, "terrazzo") },
  { slug: "wood-look", name: "Wood Look Tile", match: (r) => r.type !== "plank" && has(r, "wood look") },
  { slug: "patterned-decor", name: "Patterned & Decor", match: (r) => r.type !== "plank" && has(r, "patterned") },
  { slug: "vinyl-plank", name: "Vinyl Plank", match: (r) => r.type === "plank" },
  { slug: "carpet", name: "Carpet", match: (r) => r.type === "carpet" },
  { slug: "tile", name: "Tile", match: () => true },
];
function has(r: Row, tag: string) { return (r.tags ?? []).includes(tag); }
const num = (n: number | null) => n == null ? null : String(Number(n)).replace(/\.0+$/, "");
const title = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const list = (a: string[]) => a.length <= 1 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`;
const ext = (path: string) => (/\.(png|webp|jpe?g)$/i.exec(path)?.[1] ?? "jpg").toLowerCase();

function size(r: Row) { const a = num(r.length_in), b = num(r.width_in); return a && b ? `${Math.min(+a, +b)}" x ${Math.max(+a, +b)}"` : null; }
function describe(r: Row) {
  const kind = r.type === "plank" ? "vinyl plank" : r.type === "carpet" ? "carpet" : "tile";
  const looks = (r.tags ?? []).filter((t) => t !== "plank");
  const colour = r.colour_family ? `${r.colour_family} ` : "";
  const parts = [`${cap(colour + kind)}${size(r) ? `, ${size(r)}` : ""}.`];
  if (looks.length) parts.push(`${cap(list(looks))}.`);
  if (r.surfaces?.length) parts.push(`For ${list(r.surfaces.map((x) => `${x}s`))}.`);
  if (r.rooms?.length) parts.push(`Works well in the ${list(r.rooms)}.`);
  return parts.join(" ");
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  if (!/^[a-z0-9-]{2,60}$/.test(slug)) return json({ error: "Not found." }, 404);
  const { data, error } = await svc.rpc("storefront_products", { p_slug: slug });
  if (error) return json({ error: error.message }, 500);
  const rows = (data ?? []) as Row[];
  if (!rows.length) return json({ error: "Not found." }, 404);
  const storeId = rows[0].store_id;

  // Which public copies should exist: room photo first when there is one, then the swatch.
  type Want = { from: string; src: string; dest: string; productId: string; alt: string };
  const wants: Want[] = [];
  for (const r of rows) {
    if (r.showcase_path && r.showcase_ver) wants.push({ from: "renders", src: r.showcase_path, dest: `${storeId}/${r.id}-r-${r.showcase_ver}.${ext(r.showcase_path)}`, productId: r.id, alt: `${r.name} in a room` });
    if (r.swatch_path && r.swatch_ver) wants.push({ from: "swatches", src: r.swatch_path, dest: `${storeId}/${r.id}-s-${r.swatch_ver}.${ext(r.swatch_path)}`, productId: r.id, alt: `${r.name} sample` });
  }

  // What is there now.
  const have = new Set<string>();
  for (let offset = 0; ; offset += 1000) {
    const { data: files, error: lerr } = await svc.storage.from(BUCKET).list(storeId, { limit: 1000, offset });
    if (lerr) return json({ error: lerr.message }, 500);
    for (const f of files ?? []) have.add(`${storeId}/${f.name}`);
    if ((files ?? []).length < 1000) break;
  }

  const failed = new Set<string>();
  await pool(wants.filter((w) => !have.has(w.dest)), 8, async (w) => {
    const { error: cerr } = await svc.storage.from(w.from).copy(w.src, w.dest, { destinationBucket: BUCKET });
    if (cerr && !/exists|duplicate/i.test(cerr.message)) { console.warn("copy failed", w.src, cerr.message); failed.add(w.dest); }
  });
  const wanted = new Set(wants.map((w) => w.dest));
  const stale = [...have].filter((p) => !wanted.has(p));
  for (let i = 0; i < stale.length; i += 100) await svc.storage.from(BUCKET).remove(stale.slice(i, i + 100));

  const used = CATEGORIES.map((c, i) => ({ ...c, id: c.slug, position: i }));
  const catOf = (r: Row) => used.find((c) => c.match(r))!;
  const present = new Set(rows.map((r) => catOf(r).slug));
  const imagesByProduct: Record<string, { public_url: string; alt_text: string }[]> = {};
  for (const w of wants) {
    if (failed.has(w.dest)) continue;
    (imagesByProduct[w.productId] ??= []).push({ public_url: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${w.dest}`, alt_text: w.alt });
  }

  return json({
    site: { id: storeId, slug },
    products: rows.map((r, i) => ({
      id: r.id, name: r.name, slug: null, description: describe(r), price_cents: null, currency: "cad",
      sku: r.sku && r.sku !== r.name ? r.sku : null, stock_quantity: null, category_id: catOf(r).id, position: i,
      // Extra fields the website uses for filters and the spec table.
      material: r.type === "plank" ? "Vinyl plank" : r.type === "carpet" ? "Carpet" : "Tile",
      size: size(r), finish: r.finish, colour: r.hue ? title(r.hue) : null, tone: r.tone ? title(r.tone) : null,
      look: (r.tags ?? []).filter((t) => t !== "plank").map(title)[0] ?? null,
      rooms: r.rooms ?? [], surfaces: r.surfaces ?? [], vibes: r.vibes ?? [], collection: r.collection,
    })),
    imagesByProduct,
    categories: used.filter((c) => present.has(c.slug)).map((c) => ({ id: c.id, parent_id: null, name: c.name, slug: c.slug, position: c.position })),
  }, 200, "public, max-age=60");
});
