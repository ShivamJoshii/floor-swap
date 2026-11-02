import { supabase } from "./supabase";

type Res = { done: { id: string; path: string }[]; failed: { id: string; error: string }[]; remaining: number };

/**
 * Make the one-time room photo ("showcase") for products that don't have one yet.
 * Pass ids to limit it to those products; omit to work through every product in the store.
 * The server does 3 at a time; this loops until nothing is left or no progress is made.
 */
export async function makeShowcases(storeId: string, ids?: string[], onProgress?: (made: number, remaining: number) => void) {
  let made = 0; const failed: { id: string; error: string }[] = [];
  const queue = ids ? [...ids] : null;
  for (let guard = 0; guard < 400; guard++) {
    const batch = queue ? queue.splice(0, 3) : undefined;
    if (queue && !batch!.length) break;
    const { data, error } = await supabase.functions.invoke<Res>("showcase", { body: { store_id: storeId, product_ids: batch, limit: 3 } });
    if (error || !data) { failed.push({ id: "", error: error?.message ?? "No response" }); break; }
    made += data.done.length; failed.push(...data.failed);
    const left = queue ? queue.length : data.remaining;
    onProgress?.(made, left);
    if (!queue && (!data.done.length || !data.remaining)) break;
  }
  return { made, failed };
}

/** Kick off room photos for newly added products without waiting. */
export function queueShowcase(storeId: string, ids: string[]) {
  if (ids.length) makeShowcases(storeId, ids).catch(() => undefined);
}
