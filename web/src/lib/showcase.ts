import { supabase } from "./supabase";

type Res = { done: { id: string; path: string }[]; failed: { id: string; error: string }[]; remaining: number; out_of_images?: boolean };

/**
 * Make the room photo ("showcase") for the products someone picked.
 * Each photo uses one image from the store's plan, so nothing is made automatically.
 * The server does 3 at a time; this works through the list and stops when the store runs out of images.
 */
export async function makeShowcases(storeId: string, ids: string[], onProgress?: (made: number, remaining: number) => void) {
  let made = 0, outOfImages = false; const failed: { id: string; error: string }[] = [];
  const queue = [...ids];
  while (queue.length) {
    const batch = queue.splice(0, 3);
    const { data, error } = await supabase.functions.invoke<Res>("showcase", { body: { store_id: storeId, product_ids: batch, limit: 3, confirm: true } });
    if (error || !data) {
      let msg = error?.message ?? "No response";
      try { const j = await (error as { context?: Response } | null)?.context?.json(); if (j?.error) msg = j.error; } catch { /* keep */ }
      failed.push({ id: "", error: msg }); break;
    }
    made += data.done.length; failed.push(...data.failed);
    onProgress?.(made, queue.length);
    if (data.out_of_images) { outOfImages = true; break; }
  }
  return { made, failed, outOfImages };
}
