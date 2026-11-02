import type { Product } from "./supabase";

// Keep in sync with supabase/functions/room-render (SCENES / SPOTS).
export type Spot = "floor" | "backsplash" | "shower" | "feature_wall";
export const SPOT_LABEL: Record<Spot, string> = { floor: "Floor", backsplash: "Backsplash", shower: "Shower walls", feature_wall: "Feature wall" };

export const ROOM_TYPES: { id: string; label: string; spots: Spot[] }[] = [
  { id: "kitchen", label: "Kitchen", spots: ["floor", "backsplash", "feature_wall"] },
  { id: "bathroom", label: "Bathroom", spots: ["floor", "shower", "feature_wall"] },
  { id: "living room", label: "Living room", spots: ["floor", "feature_wall"] },
  { id: "bedroom", label: "Bedroom", spots: ["floor", "feature_wall"] },
  { id: "basement", label: "Basement", spots: ["floor", "feature_wall"] },
  { id: "entryway", label: "Entryway", spots: ["floor", "feature_wall"] },
  { id: "hallway", label: "Hallway", spots: ["floor"] },
  { id: "laundry", label: "Laundry", spots: ["floor", "backsplash"] },
];
export const roomType = (id: string) => ROOM_TYPES.find((r) => r.id === id) ?? ROOM_TYPES[0];

/** Product surface tags that fit each spot (products are tagged floor / wall / backsplash / shower). */
const FITS: Record<Spot, string[]> = { floor: ["floor"], backsplash: ["backsplash", "wall"], shower: ["shower", "wall"], feature_wall: ["wall", "backsplash", "shower"] };
export const fitsSpot = (p: Product, spot: Spot) => (p.surfaces?.length ? p.surfaces : ["floor"]).some((s) => FITS[spot].includes(s));

export type RoomDraft = {
  key: string;            // local id
  label: string;          // e.g. "Unit A kitchen"
  room_type: string;
  spots: Partial<Record<Spot, string>>; // spot -> product id
  render?: { id: string; url: string | null; combo: string } | null; // photo for the current combo
  busy?: boolean; error?: string | null;
};
export const comboOf = (r: Pick<RoomDraft, "room_type" | "spots">) =>
  [r.room_type, ...(["floor", "backsplash", "shower", "feature_wall"] as Spot[]).filter((s) => r.spots[s]).map((s) => `${s}=${r.spots[s]}`)].join("|");
