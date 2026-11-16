#!/usr/bin/env node
// Proves the two things the worker depends on, on this machine and this internet connection:
//   1. the saved login can refresh itself
//   2. ChatGPT returns an image (plain, then an edit with a reference image)
// Usage: node worker/check.mjs            refresh + one generated image
//        node worker/check.mjs --edit a.jpg b.jpg "prompt"   edit with up to 5 reference images
import { readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { AUTH_DIR, refreshNow, status } from "./auth.mjs";
import { codexImage } from "./codex.mjs";

const step = async (label, fn) => {
  process.stdout.write(`${label} ... `);
  const t = Date.now();
  try { const out = await fn(); console.log(`ok (${((Date.now() - t) / 1000).toFixed(1)}s)${out ? "  " + out : ""}`); return true; }
  catch (e) { console.log(`FAILED\n   ${e.message}`); return false; }
};

const args = process.argv.slice(2);
let ok = await step("Saved login", async () => { const s = await status(); return `account ${s.accountId}, ${s.minutesLeft} min left`; });
ok = ok && await step("Forced token refresh", async () => { await refreshNow(); const s = await status(); return `new token good until ${s.expires}`; });

if (ok && args[0] === "--edit") {
  const prompt = args[args.length - 1];
  const files = args.slice(1, -1);
  const mimeOf = (f) => ({ ".png": "image/png", ".webp": "image/webp" }[extname(f).toLowerCase()] ?? "image/jpeg");
  ok = await step(`Edit with ${files.length} reference image(s)`, async () => {
    const images = await Promise.all(files.map(async (f) => ({ bytes: await readFile(f), mime: mimeOf(f) })));
    const out = await codexImage(prompt, images);
    const path = join(AUTH_DIR, "check-edit.png");
    await writeFile(path, out.bytes);
    return `${(out.bytes.length / 1024).toFixed(0)} KB -> ${path}`;
  });
} else if (ok) {
  ok = await step("Generate one test image", async () => {
    const out = await codexImage("A photorealistic empty living room with light oak plank flooring, daylight from a window on the left.");
    const path = join(AUTH_DIR, "check.png");
    await writeFile(path, out.bytes);
    return `${(out.bytes.length / 1024).toFixed(0)} KB -> ${path}`;
  });
}
console.log(ok ? "\nAll good. This machine can run the worker." : "\nNot ready. Fix the failed step above.");
process.exit(ok ? 0 : 1);
