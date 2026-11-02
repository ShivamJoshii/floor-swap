// Floor Swap — builder-sheet: public read of one builder sheet by its unguessable token.
// No login (builders don't have accounts). Returns store branding, the products' specs and
// short-lived signed URLs for each product's room photo, swatch and the sheet PDF. Counts views.
// GET ?t=<token>   (deploy with verify_jwt = false)
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" } });
const DAY = 24 * 3600;
const SPOT_LABEL: Record<string, string> = { floor: "Floor", backsplash: "Backsplash", shower: "Shower walls", feature_wall: "Feature wall" };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const token = new URL(req.url).searchParams.get("t") ?? "";
  if (!/^[a-f0-9]{32}$/.test(token)) return json({ error: "Not found." }, 404);

  const { data: sheet } = await svc.from("builder_sheets")
    .select("id, store_id, builder_name, builder_company, note, show_prices, product_ids, rooms, pdf_path, created_at, views")
    .eq("token", token).maybeSingle();
  if (!sheet) return json({ error: "Not found." }, 404);

  const [{ data: store }, { data: rows }] = await Promise.all([
    svc.from("stores").select("name, phone, email, website, address, tagline, cta_text, brand_color, logo_path").eq("id", sheet.store_id).single(),
    svc.from("products").select("id, name, sku, type, length_in, width_in, finish, collection, colour_family, price_per_sqft, swatch_path, showcase_path")
      .eq("store_id", sheet.store_id).in("id", sheet.product_ids ?? []),
  ]);
  const byId = new Map((rows ?? []).map((p) => [p.id, p]));
  type Row = NonNullable<typeof rows>[number];

  const sign = async (bucket: string, path: string | null) => path ? (await svc.storage.from(bucket).createSignedUrl(path, DAY)).data?.signedUrl ?? null : null;
  const spec = async (p: Row, spot: string | null) => ({
    spot: spot ? SPOT_LABEL[spot] ?? spot : null, name: p.name, sku: p.sku, type: p.type, length_in: p.length_in, width_in: p.width_in, finish: p.finish, collection: p.collection, colour_family: p.colour_family,
    price_per_sqft: sheet.show_prices ? p.price_per_sqft : null,
    swatch_url: await sign("swatches", p.swatch_path),
  });

  // v2 sheets: rooms (combos) with one photo each. v1 sheets: one product per "room" using its showcase photo.
  type SheetRoom = { label?: string; room_type: string; spots: Record<string, string>; render_id?: string };
  const roomDefs = (sheet.rooms ?? []) as SheetRoom[];
  let rooms;
  if (roomDefs.length) {
    const ids = roomDefs.map((r) => r.render_id).filter(Boolean) as string[];
    const { data: rr } = ids.length ? await svc.from("room_renders").select("id, path").eq("store_id", sheet.store_id).in("id", ids) : { data: [] };
    const paths = new Map((rr ?? []).map((r) => [r.id, r.path]));
    rooms = await Promise.all(roomDefs.map(async (r) => ({
      label: r.label || r.room_type, room_type: r.room_type,
      photo_url: await sign("renders", r.render_id ? paths.get(r.render_id) ?? null : null),
      products: await Promise.all(Object.entries(r.spots ?? {}).sort(([a], [b]) => Object.keys(SPOT_LABEL).indexOf(a) - Object.keys(SPOT_LABEL).indexOf(b)).filter(([, id]) => byId.has(id)).map(([spot, id]) => spec(byId.get(id)!, spot))),
    })));
  } else {
    rooms = await Promise.all((sheet.product_ids ?? []).filter((id: string) => byId.has(id)).map(async (id: string) => {
      const p = byId.get(id)!;
      return { label: p.name, room_type: null, photo_url: await sign("renders", p.showcase_path), products: [await spec(p, null)] };
    }));
  }

  await svc.from("builder_sheets").update({ views: (sheet.views ?? 0) + 1, last_viewed_at: new Date().toISOString() }).eq("id", sheet.id);

  return json({
    store: { ...store, logo_path: undefined, logo_url: await sign("brand", store?.logo_path ?? null) },
    sheet: { builder_name: sheet.builder_name, builder_company: sheet.builder_company, note: sheet.note, show_prices: sheet.show_prices, created_at: sheet.created_at, pdf_url: await sign("proposals", sheet.pdf_path) },
    rooms,
  });
});
