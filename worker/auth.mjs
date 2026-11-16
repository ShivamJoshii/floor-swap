// ChatGPT (Codex) login for the Floor Swap image worker.
// Same OAuth protocol as the pi-codex-image-gen package (public client, PKCE, loopback port 1455).
// Tokens live in ~/.floor-swap-worker/auth.json (mode 600) and are refreshed here, nowhere else.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CALLBACK_PORT = 1455;
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}/auth/callback`;
const AUTH_CLAIM = "https://api.openai.com/auth";
const REFRESH_EARLY_MS = 24 * 60 * 60_000; // refresh once less than a day is left, so a short outage never lets it lapse

export const AUTH_DIR = process.env.FLOOR_SWAP_WORKER_DIR || join(homedir(), ".floor-swap-worker");
export const AUTH_FILE = join(AUTH_DIR, "auth.json");

export class LoginRequired extends Error {
  constructor(why) { super(`ChatGPT login needed (${why}). Run: node worker/login.mjs`); this.name = "LoginRequired"; }
}

export function accountIdOf(accessToken) {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"));
    const id = payload?.[AUTH_CLAIM]?.chatgpt_account_id;
    if (typeof id !== "string" || !id) throw new Error();
    return id;
  } catch { throw new LoginRequired("token has no ChatGPT account id"); }
}

async function save(cred) {
  await mkdir(AUTH_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${AUTH_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(cred, null, 2), { mode: 0o600 });
  await rename(tmp, AUTH_FILE); // atomic: a crash never leaves a half-written token file
}

async function load() {
  try { return JSON.parse(await readFile(AUTH_FILE, "utf8")); }
  catch { throw new LoginRequired("no saved login"); }
}

async function tokenRequest(params) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`token endpoint ${res.status}`);
    err.status = res.status;
    err.rejected = res.status === 400 || res.status === 401 || res.status === 403; // refresh token no longer accepted
    throw err;
  }
  const data = JSON.parse(text);
  if (!data.access_token || !data.refresh_token || !(data.expires_in > 0)) throw new Error("token endpoint returned an incomplete response");
  return {
    access: data.access_token,
    refresh: data.refresh_token,
    expires: Date.now() + data.expires_in * 1000,
    accountId: accountIdOf(data.access_token),
    refreshedAt: new Date().toISOString(),
  };
}

let inflight = null; // one refresh at a time; the refresh token is single-use

export async function refreshNow() {
  if (!inflight) {
    inflight = (async () => {
      const cred = await load();
      try {
        const next = await tokenRequest({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: cred.refresh });
        await save(next);
        return next;
      } catch (e) {
        if (e.rejected) throw new LoginRequired("refresh token was rejected; signed out or revoked");
        throw e; // network trouble: keep the saved login and try again later
      }
    })().finally(() => { inflight = null; });
  }
  return inflight;
}

/** A valid access token + account id, refreshing first when it is about to expire. */
export async function getAuth() {
  const cred = await load();
  if (cred.expires - Date.now() > REFRESH_EARLY_MS) return cred;
  try { return await refreshNow(); }
  catch (e) {
    // Network trouble while the current token still works: keep using it and retry the refresh next time.
    if (!(e instanceof LoginRequired) && cred.expires - Date.now() > 60_000) return cred;
    throw e;
  }
}

export async function status() {
  const cred = await load();
  return { accountId: cred.accountId, expires: new Date(cred.expires).toISOString(), minutesLeft: Math.round((cred.expires - Date.now()) / 60_000), refreshedAt: cred.refreshedAt ?? null };
}

/** Browser login. Prints a URL, waits for the redirect on 127.0.0.1:1455, saves the tokens. */
export async function login({ onUrl }) {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const code = new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", REDIRECT_URI);
      if (url.pathname !== "/auth/callback" || url.searchParams.get("state") !== state) { res.writeHead(400).end("Invalid login callback."); return; }
      const c = url.searchParams.get("code");
      res.writeHead(c ? 200 : 400, { "Content-Type": "text/plain; charset=utf-8" }).end(c ? "Floor Swap image login done. You can close this tab." : "Login was denied.");
      server.close(); server.closeAllConnections?.();
      c ? resolve(c) : reject(new Error("Login was denied in the browser."));
    });
    server.once("error", (e) => reject(new Error(`Could not listen on port ${CALLBACK_PORT} (${e.code}). Close the Codex app/CLI login window if one is open and retry.`)));
    server.listen(CALLBACK_PORT, "127.0.0.1");
    setTimeout(() => { server.close(); reject(new Error("Login timed out after 10 minutes.")); }, 10 * 60_000).unref();
  });

  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    scope: "openid profile email offline_access", state,
    code_challenge: challenge, code_challenge_method: "S256",
    id_token_add_organizations: "true", codex_cli_simplified_flow: "true", originator: "pi",
  }).toString();
  onUrl(url.href);

  const cred = await tokenRequest({ grant_type: "authorization_code", client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, code: await code, code_verifier: verifier });
  await save(cred);
  return cred;
}
