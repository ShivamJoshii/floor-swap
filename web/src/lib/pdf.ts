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
