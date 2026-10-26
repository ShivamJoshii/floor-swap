// Dominant tone/hue of a swatch. Mirrors the Python classifier used for the bulk imports.
export type Tone = "light" | "medium" | "dark";
export type Hue = "white" | "grey" | "beige" | "warm" | "brown" | "black" | "blue" | "green" | "multi";
export const HUES: Hue[] = ["white", "grey", "beige", "warm", "brown", "black", "blue", "green", "multi"];
export const TONES: Tone[] = ["light", "medium", "dark"];
export const SURFACES = ["floor", "wall", "backsplash", "shower"] as const;
export const ROOMS = ["living room", "bedroom", "kitchen", "bathroom", "basement", "hallway", "entryway", "laundry", "office", "stairs"] as const;

function rgbToHls(r: number, g: number, b: number) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return { h: 0, l, s: 0 };
  const d = max - min; const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h /= 6; return { h, l, s };
}

export function classify(bmp: ImageBitmap | HTMLCanvasElement | HTMLImageElement, insetFrac = 0): { tone: Tone; hue: Hue } {
  const c = document.createElement("canvas"); c.width = 64; c.height = 64;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  const w = "width" in bmp ? bmp.width : 64, h = "height" in bmp ? bmp.height : 64;
  const ix = Math.round(w * insetFrac), iy = Math.round(h * insetFrac);
  ctx.drawImage(bmp as CanvasImageSource, ix, iy, w - 2 * ix, h - 2 * iy, 0, 0, 64, 64);
  const d = ctx.getImageData(0, 0, 64, 64).data;
  const px: [number, number, number][] = [];
  for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2]]);
  px.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  const n = px.length, keep = px.slice(Math.floor(n / 10), n - Math.floor(n / 10));
  let r = 0, g = 0, b = 0; for (const p of keep) { r += p[0]; g += p[1]; b += p[2]; } r /= keep.length; g /= keep.length; b /= keep.length;
  const { h: hh, s } = rgbToHls(r / 255, g / 255, b / 255); const hdeg = hh * 360;
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const tone: Tone = L >= 165 ? "light" : L >= 95 ? "medium" : "dark";
  const warmish = (hdeg >= 15 && hdeg <= 70) || hdeg > 330;
  let hue: Hue;
  if (s < 0.10 || (L >= 190 && s < 0.22 && !warmish)) hue = L >= 200 ? "white" : L < 60 ? "black" : "grey";
  else if (warmish) hue = L >= 150 ? (s < 0.40 ? "beige" : "warm") : L >= 95 ? "warm" : "brown";
  else if (hdeg > 70 && hdeg <= 170 && s >= 0.18) hue = "green";
  else if (hdeg > 170 && hdeg <= 260 && s >= 0.18) hue = "blue";
  else if (s < 0.18) hue = "grey";
  else hue = "multi";
  return { tone, hue };
}

/** Default surfaces/rooms/tags from what we know about a product. Staff can override. */
export function suggestTags(p: { name: string; type: string; collection?: string | null; length_in?: number | null; width_in?: number | null }) {
  const n = p.name.toLowerCase(), cat = (p.collection ?? "").toLowerCase();
  let surfaces = new Set<string>(["floor"]); const rooms = new Set<string>(); const tags = new Set<string>();
  if (p.type === "plank") { ["living room", "bedroom", "kitchen", "basement", "hallway"].forEach((x) => rooms.add(x)); tags.add("plank"); }
  if (p.type === "carpet") { ["bedroom", "basement", "living room", "stairs"].forEach((x) => rooms.add(x)); tags.add("carpet"); }
  if (p.type === "other" || /mosaic/.test(n) || /mosaic/.test(cat)) { surfaces = new Set(["wall", "backsplash", "shower"]); rooms.add("kitchen"); rooms.add("bathroom"); tags.add("mosaic"); }
  if (p.type === "tile") {
    ["kitchen", "bathroom", "entryway", "laundry"].forEach((x) => rooms.add(x));
    const L = p.length_in ?? 0, W = p.width_in ?? 0; const small = L > 0 && L <= 12 && W <= 6;
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
  return { surfaces: [...surfaces].sort(), rooms: [...rooms].sort(), tags: [...tags].sort() };
}
