#!/usr/bin/env node
// Writes ~/.floor-swap-worker/config.json and prints the hash of the worker secret.
// The secret never leaves this machine; only its hash goes into the database.
// Usage: node worker/setup.mjs --url https://<ref>.supabase.co --key <publishable key>
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AUTH_DIR } from "./auth.mjs";

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const file = join(AUTH_DIR, "config.json");
let cfg = {};
try { cfg = JSON.parse(await readFile(file, "utf8")); } catch { /* first run */ }
cfg.supabaseUrl = (arg("url") ?? cfg.supabaseUrl ?? "").replace(/\/+$/, "");
cfg.apiKey = arg("key") ?? cfg.apiKey;
cfg.secret = cfg.secret ?? randomBytes(32).toString("base64url");
cfg.concurrency = Number(arg("concurrency") ?? cfg.concurrency ?? 3);
if (!cfg.supabaseUrl || !cfg.apiKey) { console.error("Need --url and --key."); process.exit(1); }
await mkdir(AUTH_DIR, { recursive: true, mode: 0o700 });
await writeFile(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
console.log(`Config saved to ${file}`);
console.log(`WORKER HASH: ${createHash("sha256").update(cfg.secret).digest("hex")}`);
