import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_KEY as string | undefined;

export const configured = Boolean(url && key);
export const supabase = createClient(url ?? "https://placeholder.supabase.co", key ?? "placeholder");

/** Where stores go to buy credits until Stripe is wired. */
export const SALES_CONTACT = "mybuilderagency@gmail.com";

export type Store = {
  id: string; name: string; city: string | null; phone?: string | null; email?: string | null; address?: string | null; website?: string | null;
  tagline?: string | null; cta_text?: string | null; brand_color?: string | null; logo_path?: string | null;
};
export type Membership = { store_id: string; role: "owner" | "staff"; stores: Store };
export type Product = {
  id: string; store_id: string; name: string; sku: string | null; type: "plank" | "tile" | "carpet" | "other";
  length_in: number | null; width_in: number | null; price_per_sqft: number | null; swatch_path: string; notes: string | null; active: boolean; created_at: string;
  supplier_id?: string | null; supplier_product_id?: string | null; finish?: string | null; colour_family?: string | null; collection?: string | null;
  surfaces?: string[]; rooms?: string[]; tone?: string | null; hue?: string | null; tags?: string[];
};
export type Supplier = { id: string; name: string; website: string | null; region: string | null; store_id: string | null; created_by: string | null };
export type SupplierProduct = {
  id: string; supplier_id: string; sku: string; name: string; type: "plank" | "tile" | "carpet" | "other"; length_in: number | null; width_in: number | null;
  thickness_mm: number | null; finish: string | null; colour_family: string | null; collection: string | null; notes: string | null; swatch_path: string | null; created_by: string | null;
};
export type Render = {
  id: string; store_id: string; product_id: string | null; user_id: string | null; room_path: string;
  status: "queued" | "running" | "done" | "failed"; outputs: { path: string; width?: number; height?: number }[];
  error: string | null; credits_charged: number; lead_name: string | null; lead_phone: string | null; created_at: string; options: Record<string, string>;
};
export type Pack = { id: string; name: string; credits: number; price_cents: number; currency: string; sort: number };

export async function signedUrl(bucket: string, path: string, seconds = 3600) {
  const { data } = await supabase.storage.from(bucket).createSignedUrl(path, seconds);
  return data?.signedUrl ?? null;
}

export function money(cents: number, currency = "CAD") {
  const whole = Math.abs(cents % 100) < 0.5;
  return new Intl.NumberFormat("en-CA", { style: "currency", currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 }).format(cents / 100);
}

/** Downscale an image file in the browser before upload (max long side). Returns a JPEG blob. */
export async function shrinkImage(file: File, maxSide = 2048, quality = 0.9): Promise<Blob> {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) return file;
  const sc = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * sc), h = Math.round(bmp.height * sc);
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  c.getContext("2d")!.drawImage(bmp, 0, 0, w, h);
  return await new Promise<Blob>((res) => c.toBlob((b) => res(b ?? file), "image/jpeg", quality));
}
