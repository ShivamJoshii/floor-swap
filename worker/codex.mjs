// One image out of the ChatGPT (Codex) backend, billed to the logged-in ChatGPT subscription.
// Mirrors the "images" transport of pi-codex-image-gen: PNG only, size and quality chosen by the backend.
import { randomUUID } from "node:crypto";
import { getAuth, refreshNow, LoginRequired } from "./auth.mjs";

const IMAGES_URL = process.env.FLOOR_SWAP_CODEX_URL || "https://chatgpt.com/backend-api/codex/images"; // override is for tests only
const DEADLINE_MS = 5 * 60_000;

/**
 * @param {string} prompt
 * @param {{bytes: Uint8Array|Buffer, mime: string}[]} images  reference images (room photo, swatch); empty = plain generation
 * @returns {Promise<{bytes: Buffer, mime: "image/png"}>}
 */
export async function codexImage(prompt, images = []) {
  const body = JSON.stringify({
    prompt,
    background: images.length ? "auto" : "opaque",
    model: "gpt-image-2",
    quality: "auto",
    size: "auto",
    ...(images.length ? { images: images.map((im) => ({ image_url: `data:${im.mime};base64,${Buffer.from(im.bytes).toString("base64")}` })) } : {}),
  });
  const endpoint = `${IMAGES_URL}/${images.length ? "edits" : "generations"}`;

  const call = async (auth) => fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${auth.access}`,
      "chatgpt-account-id": auth.accountId,
      originator: "pi",
      "User-Agent": "pi-codex-image-gen",
      "OpenAI-Beta": "responses=experimental",
      accept: "application/json",
      "content-type": "application/json",
      "x-client-request-id": randomUUID(),
      "x-codex-image-turn-id": randomUUID(),
    },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(DEADLINE_MS),
  });

  let res = await call(await getAuth());
  if (res.status === 401) res = await call(await refreshNow()); // token expired early: refresh once and retry
  const text = await res.text();

  if (!res.ok) {
    if (res.status === 401) throw new LoginRequired("ChatGPT rejected the token after a refresh");
    const looksLikeCloudflare = /<html|cf-chl|just a moment/i.test(text);
    const err = new Error(looksLikeCloudflare
      ? `ChatGPT blocked the request at Cloudflare (${res.status}). This is a network/IP block, not a login problem.`
      : `ChatGPT image request failed (${res.status}): ${text.slice(0, 400)}`);
    err.status = res.status;
    err.quota = res.status === 429;
    throw err;
  }

  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error("ChatGPT returned something that is not JSON."); }
  if (parsed.error || parsed.detail) throw new Error(`ChatGPT refused: ${JSON.stringify(parsed.error ?? parsed.detail).slice(0, 400)}`);
  const b64 = parsed.data?.[0]?.b64_json;
  if (typeof b64 !== "string" || !b64) throw new Error("ChatGPT returned no image.");
  return { bytes: Buffer.from(b64, "base64"), mime: "image/png" };
}
