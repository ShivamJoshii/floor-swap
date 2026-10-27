import { useMemo, useState } from "react";
import type { Product, Supplier } from "../lib/supabase";
import { HUES, TONES, SURFACES, ROOMS } from "../lib/colour";

export type Filters = { q: string; surface: string; room: string; type: string; hue: string; tone: string; supplier: string; tag: string };
export const emptyFilters: Filters = { q: "", surface: "", room: "", type: "", hue: "", tone: "", supplier: "", tag: "" };

export function applyFilters(list: Product[], f: Filters): Product[] {
  const q = f.q.trim().toLowerCase();
  const words = q ? q.split(/\s+/) : [];
  return list.filter((p) => {
    if (f.surface && !(p.surfaces ?? []).includes(f.surface)) return false;
    if (f.room && !(p.rooms ?? []).includes(f.room)) return false;
    if (f.type && p.type !== f.type) return false;
    if (f.hue && p.hue !== f.hue) return false;
    if (f.tone && p.tone !== f.tone) return false;
    if (f.supplier && p.supplier_id !== f.supplier) return false;
    if (f.tag && !(p.tags ?? []).includes(f.tag)) return false;
    if (words.length) {
      const hay = [p.name, p.sku, p.collection, p.finish, p.colour_family, p.notes, p.tone, p.hue, ...(p.tags ?? []), ...(p.rooms ?? []), ...(p.surfaces ?? [])].filter(Boolean).join(" ").toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}

export default function ProductFilter({ list, suppliers, value, onChange, compact, hideSurface }: { list: Product[]; suppliers: Supplier[]; value: Filters; onChange: (f: Filters) => void; compact?: boolean; hideSurface?: boolean }) {
  const [more, setMore] = useState(false);
  const tags = useMemo(() => { const m = new Map<string, number>(); list.forEach((p) => (p.tags ?? []).forEach((t) => m.set(t, (m.get(t) ?? 0) + 1))); return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14); }, [list]);
  const set = (k: keyof Filters, v: string) => onChange({ ...value, [k]: value[k] === v ? "" : v });
  const active = Object.entries(value).filter(([k, v]) => v && k !== "q" && !(hideSurface && k === "surface")).length;
  const Chip = ({ k, v, label }: { k: keyof Filters; v: string; label?: string }) => (
    <button type="button" className={"sm" + (value[k] === v ? " on" : "")} onClick={() => set(k, v)} style={{ padding: "3px 8px", fontSize: 12 }}>{label ?? v}</button>
  );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div className="row">
        <input type="search" className="grow" placeholder="Search products" value={value.q} onChange={(e) => onChange({ ...value, q: e.target.value })} style={{ minWidth: 160 }} />
        {!compact && <button type="button" className="sm ghost" onClick={() => setMore(!more)}>{more ? "Less" : `Filters${active ? ` · ${active}` : ""}`}</button>}
        {active > 0 && <button type="button" className="sm ghost" onClick={() => onChange({ ...emptyFilters, q: value.q, surface: hideSurface ? value.surface : "" })}>Clear</button>}
      </div>
      <div className="row swatches" style={{ gap: 6 }}>
        {HUES.filter((h) => h !== "multi").map((h) => <button key={h} type="button" title={h} aria-label={h} className={"dot" + (value.hue === h ? " on" : "")} data-hue={h} onClick={() => set("hue", h)} />)}
      </div>
      {(more || compact) && (
        <>
          {!hideSurface && <div className="row" style={{ gap: 4 }}>
            <span className="small muted" style={{ width: 54 }}>Where</span>
            {SURFACES.map((s) => <Chip key={s} k="surface" v={s} />)}
          </div>}
          <div className="row" style={{ gap: 4 }}>
            <span className="small muted" style={{ width: 54 }}>Shade</span>
            {TONES.map((t) => <Chip key={t} k="tone" v={t} />)}
          </div>
          <div className="row" style={{ gap: 4 }}>
            <span className="small muted" style={{ width: 54 }}>Type</span>
            {["plank", "tile", "carpet", "other"].map((t) => <Chip key={t} k="type" v={t} label={t === "other" ? "mosaic/other" : t} />)}
          </div>
          <div className="row" style={{ gap: 4 }}>
            <span className="small muted" style={{ width: 54 }}>Room</span>
            {ROOMS.map((r) => <Chip key={r} k="room" v={r} />)}
          </div>
          {suppliers.length > 0 && (
            <div className="row" style={{ gap: 4 }}>
              <span className="small muted" style={{ width: 54 }}>Supplier</span>
              {suppliers.map((s) => <Chip key={s.id} k="supplier" v={s.id} label={s.name} />)}
            </div>
          )}
          {tags.length > 0 && (
            <div className="row" style={{ gap: 4 }}>
              <span className="small muted" style={{ width: 54 }}>Tags</span>
              {tags.map(([t, n]) => <Chip key={t} k="tag" v={t} label={`${t} · ${n}`} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
