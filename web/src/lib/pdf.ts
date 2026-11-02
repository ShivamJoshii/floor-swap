import { PDFDocument, StandardFonts, rgb, type PDFImage, type PDFPage, type PDFFont } from "pdf-lib";
import type { Store } from "./supabase";

export type ProposalItem = {
  render_id: string; output_path: string; url: string;
  product: { id: string; name: string; type: string; length_in: number | null; width_in: number | null; swatch_path: string };
  swatchUrl?: string | null; room_path: string;
};

const PAGE_W = 612, PAGE_H = 792, M = 48;

function hex(h: string | null | undefined, fallback = "#9a5a1c") {
  const s = (h && /^#[0-9a-f]{6}$/i.test(h) ? h : fallback).slice(1);
  return rgb(parseInt(s.slice(0, 2), 16) / 255, parseInt(s.slice(2, 4), 16) / 255, parseInt(s.slice(4, 6), 16) / 255);
}
async function fetchImage(doc: PDFDocument, url: string | null | undefined): Promise<PDFImage | null> {
  if (!url) return null;
  try {
    const r = await fetch(url); if (!r.ok) return null;
    const bytes = new Uint8Array(await r.arrayBuffer());
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    return isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  } catch { return null; }
}
function drawFit(page: PDFPage, img: PDFImage, x: number, y: number, w: number, h: number) {
  const s = Math.min(w / img.width, h / img.height); const dw = img.width * s, dh = img.height * s;
  page.drawImage(img, { x: x + (w - dw) / 2, y: y + (h - dh) / 2, width: dw, height: dh });
  return { x: x + (w - dw) / 2, y: y + (h - dh) / 2, width: dw, height: dh };
}
function wrap(text: string, font: PDFFont, size: number, maxW: number) {
  const words = text.split(/\s+/); const lines: string[] = []; let cur = "";
  for (const w of words) { const t = cur ? cur + " " + w : w; if (font.widthOfTextAtSize(t, size) > maxW && cur) { lines.push(cur); cur = w; } else cur = t; }
  if (cur) lines.push(cur); return lines;
}
const sizeText = (p: ProposalItem["product"]) => p.length_in && p.width_in ? `${p.length_in}" × ${p.width_in}"` : "";
const typeText = (t: string) => ({ plank: "Plank", tile: "Tile", carpet: "Carpet", other: "" } as Record<string, string>)[t] ?? "";

export async function buildProposalPdf(opts: { store: Store; lead: { name: string; phone: string }; beforeUrl: string | null; items: ProposalItem[]; logoUrl?: string | null }) {
  const { store, lead, items } = opts;
  const doc = await PDFDocument.create();
  doc.setTitle(`${store.name} — flooring options${lead.name ? ` for ${lead.name}` : ""}`);
  doc.setAuthor(store.name);
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.12, 0.11, 0.08), muted = rgb(0.44, 0.41, 0.36), line = rgb(0.86, 0.84, 0.79), accent = hex(store.brand_color);
  const date = new Date().toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" });
  const contact = [store.phone, store.email, store.website, store.address].filter(Boolean).join("   ·   ");
  const logo = await fetchImage(doc, opts.logoUrl);

  const header = (page: PDFPage, right: string) => {
    page.drawRectangle({ x: 0, y: PAGE_H - 6, width: PAGE_W, height: 6, color: accent });
    if (logo) drawFit(page, logo, M, PAGE_H - 54, 120, 30);
    else page.drawText(store.name.toUpperCase(), { x: M, y: PAGE_H - 44, size: 11, font: bold, color: ink });
    const w = font.widthOfTextAtSize(right, 9);
    page.drawText(right, { x: PAGE_W - M - w, y: PAGE_H - 44, size: 9, font, color: muted });
  };
  const footer = (page: PDFPage, text: string) => {
    page.drawLine({ start: { x: M, y: 58 }, end: { x: PAGE_W - M, y: 58 }, thickness: 0.5, color: line });
    wrap(text, font, 8, PAGE_W - 2 * M).slice(0, 2).forEach((l, i) => page.drawText(l, { x: M, y: 44 - i * 11, size: 8, font, color: muted }));
  };

  // Cover
  {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    header(page, date);
    let y = PAGE_H - 120;
    page.drawText(store.name, { x: M, y, size: 30, font: bold, color: ink }); y -= 22;
    if (store.tagline) { page.drawText(store.tagline, { x: M, y, size: 12, font, color: muted }); y -= 18; }
    y -= 14;
    const title = lead.name ? `Flooring options for ${lead.name}` : "Your flooring options";
    page.drawText(title, { x: M, y, size: 16, font: bold, color: accent }); y -= 16;
    page.drawText(`${items.length} option${items.length === 1 ? "" : "s"} rendered on your own photo`, { x: M, y, size: 11, font, color: muted }); y -= 28;
    const before = await fetchImage(doc, opts.beforeUrl);
    if (before) {
      const r = drawFit(page, before, M, y - 360, PAGE_W - 2 * M, 360);
      page.drawText("Your room today", { x: r.x, y: r.y - 14, size: 9, font, color: muted });
    }
    footer(page, contact);
  }

  // One page per option
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const page = doc.addPage([PAGE_W, PAGE_H]);
    header(page, `Option ${i + 1} of ${items.length}`);
    const img = await fetchImage(doc, it.url);
    let y = PAGE_H - 80;
    if (img) { const r = drawFit(page, img, M, y - 400, PAGE_W - 2 * M, 400); y = r.y - 22; } else { page.drawText("Image unavailable", { x: M, y: y - 20, size: 12, font, color: muted }); y -= 60; }
    const sw = await fetchImage(doc, it.swatchUrl);
    const textX = sw ? M + 128 : M;
    if (sw) { const r = drawFit(page, sw, M, y - 84, 112, 84); page.drawRectangle({ x: r.x, y: r.y, width: r.width, height: r.height, borderColor: line, borderWidth: 0.5 }); }
    page.drawText(it.product.name, { x: textX, y: y - 18, size: 18, font: bold, color: ink });
    const sub = [typeText(it.product.type), sizeText(it.product)].filter(Boolean).join("  ·  ");
    if (sub) page.drawText(sub, { x: textX, y: y - 38, size: 11, font, color: muted });
    page.drawText(`Option ${i + 1}`, { x: textX, y: y - 58, size: 10, font: bold, color: accent });
    footer(page, "Preview generated from your photo with the actual product's sample. Colour and pattern are close to real; confirm with a sample in the showroom before ordering.");
  }

  // Closing
  {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    header(page, date);
    let y = PAGE_H - 160;
    const cta = store.cta_text || "Ready for the next step?";
    wrap(cta, bold, 26, PAGE_W - 2 * M).forEach((l) => { page.drawText(l, { x: M, y, size: 26, font: bold, color: ink }); y -= 32; });
    y -= 10;
    const lines = [
      store.phone ? ["Call or text", store.phone] : null,
      store.email ? ["Email", store.email] : null,
      store.website ? ["Web", store.website] : null,
      store.address ? ["Showroom", store.address] : null,
    ].filter(Boolean) as [string, string][];
    for (const [k, v] of lines) {
      page.drawText(k.toUpperCase(), { x: M, y, size: 8, font: bold, color: muted });
      page.drawText(v, { x: M, y: y - 16, size: 14, font, color: ink }); y -= 44;
    }
    if (lead.name || lead.phone) {
      y -= 10; page.drawLine({ start: { x: M, y }, end: { x: PAGE_W - M, y }, thickness: 0.5, color: line }); y -= 22;
      page.drawText(`Prepared for ${[lead.name, lead.phone].filter(Boolean).join(" · ")} on ${date}`, { x: M, y, size: 10, font, color: muted });
    }
    footer(page, contact);
  }
  return await doc.save();
}

// ---------- Builder sheet: room photo + specs per product, no customer photo ----------

export type SheetProduct = {
  name: string; sku: string | null; type: string; length_in: number | null; width_in: number | null;
  finish?: string | null; collection?: string | null; colour_family?: string | null; price_per_sqft?: number | null;
  roomUrl: string | null; swatchUrl: string | null;
};

export function specRows(p: Omit<SheetProduct, "roomUrl" | "swatchUrl">, showPrices: boolean): [string, string][] {
  const rows: [string, string][] = [
    ["Type", typeText(p.type)],
    ["Size", p.length_in && p.width_in ? `${p.length_in}" × ${p.width_in}"` : ""],
    ["Finish", p.finish ?? ""],
    ["Collection", p.collection ?? ""],
    ["Colour", p.colour_family ?? ""],
    ["SKU", p.sku ?? ""],
  ];
  if (showPrices && p.price_per_sqft != null) rows.push(["Price", `$${Number(p.price_per_sqft).toFixed(2)} / sq ft`]);
  return rows.filter(([, v]) => v);
}

export async function buildBuilderPdf(opts: { store: Store; builder: { name: string; company: string }; note: string; showPrices: boolean; items: SheetProduct[]; logoUrl?: string | null }) {
  const { store, builder, items } = opts;
  const who = builder.company || builder.name;
  const doc = await PDFDocument.create();
  doc.setTitle(`${store.name} — product sheet${who ? ` for ${who}` : ""}`);
  doc.setAuthor(store.name);
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.12, 0.11, 0.08), muted = rgb(0.44, 0.41, 0.36), line = rgb(0.86, 0.84, 0.79), accent = hex(store.brand_color);
  const date = new Date().toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" });
  const contact = [store.phone, store.email, store.website, store.address].filter(Boolean).join("   ·   ");
  const logo = await fetchImage(doc, opts.logoUrl);
  const header = (page: PDFPage, right: string) => {
    page.drawRectangle({ x: 0, y: PAGE_H - 6, width: PAGE_W, height: 6, color: accent });
    if (logo) drawFit(page, logo, M, PAGE_H - 54, 120, 30);
    else page.drawText(store.name.toUpperCase(), { x: M, y: PAGE_H - 44, size: 11, font: bold, color: ink });
    const w = font.widthOfTextAtSize(right, 9);
    page.drawText(right, { x: PAGE_W - M - w, y: PAGE_H - 44, size: 9, font, color: muted });
  };
  const footer = (page: PDFPage, text: string) => {
    page.drawLine({ start: { x: M, y: 58 }, end: { x: PAGE_W - M, y: 58 }, thickness: 0.5, color: line });
    wrap(text, font, 8, PAGE_W - 2 * M).slice(0, 2).forEach((l, i) => page.drawText(l, { x: M, y: 44 - i * 11, size: 8, font, color: muted }));
  };

  // Cover: title, note, a contact strip and up to 4 room photos as a teaser grid.
  {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    header(page, date);
    let y = PAGE_H - 120;
    page.drawText(store.name, { x: M, y, size: 30, font: bold, color: ink }); y -= 22;
    if (store.tagline) { page.drawText(store.tagline, { x: M, y, size: 12, font, color: muted }); y -= 18; }
    y -= 14;
    page.drawText(who ? `Product sheet for ${who}` : "Product sheet", { x: M, y, size: 16, font: bold, color: accent }); y -= 16;
    page.drawText(`${items.length} product${items.length === 1 ? "" : "s"} · room photo and specs for each`, { x: M, y, size: 11, font, color: muted }); y -= 22;
    if (opts.note.trim()) { for (const l of wrap(opts.note.trim(), font, 11, PAGE_W - 2 * M).slice(0, 5)) { page.drawText(l, { x: M, y, size: 11, font, color: ink }); y -= 15; } y -= 8; }
    const grid = items.slice(0, 4); const gw = (PAGE_W - 2 * M - 12) / 2, gh = gw * 0.75;
    for (let i = 0; i < grid.length; i++) {
      const img = await fetchImage(doc, grid[i].roomUrl ?? grid[i].swatchUrl); if (!img) continue;
      const gx = M + (i % 2) * (gw + 12), gy = y - gh - Math.floor(i / 2) * (gh + 26);
      if (gy < 80) break;
      drawFit(page, img, gx, gy, gw, gh);
      page.drawText(grid[i].name.slice(0, 48), { x: gx, y: gy - 13, size: 9, font, color: muted });
    }
    footer(page, contact);
  }

  // One page per product
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const page = doc.addPage([PAGE_W, PAGE_H]);
    header(page, `${i + 1} of ${items.length}`);
    let y = PAGE_H - 80;
    const room = await fetchImage(doc, it.roomUrl);
    if (room) { const r = drawFit(page, room, M, y - 390, PAGE_W - 2 * M, 390); y = r.y - 24; } else y -= 10;
    const sw = await fetchImage(doc, it.swatchUrl);
    const textX = sw ? M + 140 : M;
    if (sw) { const r = drawFit(page, sw, M, y - 120, 124, 120); page.drawRectangle({ x: r.x, y: r.y, width: r.width, height: r.height, borderColor: line, borderWidth: 0.5 }); }
    page.drawText(it.name, { x: textX, y: y - 18, size: 18, font: bold, color: ink });
    let ty = y - 42;
    for (const [k, v] of specRows(it, opts.showPrices)) {
      page.drawText(k.toUpperCase(), { x: textX, y: ty, size: 8, font: bold, color: muted });
      page.drawText(v.slice(0, 60), { x: textX + 80, y: ty, size: 11, font, color: ink }); ty -= 17;
    }
    footer(page, (room ? "Room photo is an AI-styled preview made from the actual product sample. " : "") + "Confirm colour with a physical sample before ordering. " + (store.phone ? `Questions or samples: ${store.phone}` : ""));
  }

  // Closing contact page
  {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    header(page, date);
    let y = PAGE_H - 160;
    for (const l of wrap(store.cta_text || "Want samples or a quote?", bold, 26, PAGE_W - 2 * M)) { page.drawText(l, { x: M, y, size: 26, font: bold, color: ink }); y -= 32; }
    y -= 10;
    const lines = [store.phone ? ["Call or text", store.phone] : null, store.email ? ["Email", store.email] : null, store.website ? ["Web", store.website] : null, store.address ? ["Showroom", store.address] : null].filter(Boolean) as [string, string][];
    for (const [k, v] of lines) { page.drawText(k.toUpperCase(), { x: M, y, size: 8, font: bold, color: muted }); page.drawText(v, { x: M, y: y - 16, size: 14, font, color: ink }); y -= 44; }
    footer(page, contact);
  }
  return await doc.save();
}
