#!/usr/bin/env node
// Floor Swap image worker. Runs forever on one machine:
//   - tells the database it is alive and logged in (heartbeat), which is what switches the ChatGPT route on
//   - claims queued render jobs, generates each through ChatGPT, uploads the PNG, marks the job done
// It only makes outbound HTTPS calls. No open ports.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AUTH_DIR, getAuth, LoginRequired } from "./auth.mjs";
import { codexImage } from "./codex.mjs";

const cfg = JSON.parse(await readFile(join(AUTH_DIR, "config.json"), "utf8").catch(() => { console.error("No config. Run: node worker/setup.mjs --url ... --key ..."); process.exit(1); }));
const POLL_MS = 2000, HEARTBEAT_MS = 15_000, QUOTA_PAUSE_MS = 15 * 60_000;
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function rpc(name, args) {
  const res = await fetch(`${cfg.supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: { apikey: cfg.apiKey, Authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ p_secret: cfg.secret, ...args }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name} ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

let loginOk = false, note = "starting", pausedUntil = 0, active = 0, done = 0, failed = 0;
const healthy = () => loginOk && Date.now() > pausedUntil;

async function heartbeat() {
  try { await getAuth(); loginOk = true; if (Date.now() > pausedUntil) note = "ok"; } // also refreshes the token when it is close to expiry
  catch (e) { loginOk = !(e instanceof LoginRequired) && loginOk; note = e.message.slice(0, 200); log("auth:", e.message); }
  try { await rpc("codex_heartbeat", { p_ok: healthy(), p_note: `${note} | active ${active}, done ${done}, failed ${failed}` }); }
  catch (e) { log("heartbeat failed:", e.message); }
}

async function run(job) {
  active++;
  const t = Date.now();
  try {
    const images = await Promise.all(job.input_urls.map(async (u) => {
      const r = await fetch(u, { signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`could not download an input image (${r.status})`);
      return { bytes: Buffer.from(await r.arrayBuffer()), mime: (r.headers.get("content-type") ?? "image/jpeg").split(";")[0] };
    }));
    const out = await codexImage(job.prompt, images);
    const up = await fetch(job.upload_url, { method: "PUT", headers: { "content-type": out.mime, "cache-control": "max-age=3600" }, body: out.bytes, signal: AbortSignal.timeout(60_000) });
    if (!up.ok) throw new Error(`upload failed (${up.status}): ${(await up.text()).slice(0, 200)}`);
    await rpc("codex_finish", { p_id: job.id, p_ok: true, p_error: null });
    done++;
    log(`job ${job.id} done in ${((Date.now() - t) / 1000).toFixed(1)}s (${(out.bytes.length / 1024).toFixed(0)} KB)`);
  } catch (e) {
    failed++;
    if (e instanceof LoginRequired) { loginOk = false; note = e.message; }
    if (e.quota) { pausedUntil = Date.now() + QUOTA_PAUSE_MS; note = "ChatGPT image limit hit; paused 15 min"; }
    log(`job ${job.id} FAILED: ${e.message}`);
    await rpc("codex_finish", { p_id: job.id, p_ok: false, p_error: e.message.slice(0, 500) }).catch((x) => log("finish failed:", x.message));
    if (e instanceof LoginRequired || e.quota) await heartbeat(); // tell the app right away so it stops queueing here
  } finally { active--; }
}

log(`worker up. concurrency ${cfg.concurrency}, project ${cfg.supabaseUrl}`);
await heartbeat();
setInterval(heartbeat, HEARTBEAT_MS);
for (;;) {
  try {
    while (healthy() && active < cfg.concurrency) {
      const rows = await rpc("codex_claim", {});
      const job = Array.isArray(rows) ? rows[0] : rows;
      if (!job?.id) break;
      log(`job ${job.id} claimed`);
      void run(job);
    }
  } catch (e) { log("claim failed:", e.message); }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
