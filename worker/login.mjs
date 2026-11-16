#!/usr/bin/env node
// One-time ChatGPT login for the image worker. Run it on the machine that will run the worker.
import { spawn } from "node:child_process";
import { AUTH_FILE, login } from "./auth.mjs";

const cred = await login({
  onUrl(url) {
    console.log("\nSign in with the ChatGPT account that should pay for the images:\n\n" + url + "\n");
    if (process.platform === "darwin") spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    console.log("Waiting for the browser (10 minutes)...");
  },
});
console.log(`\nLogged in. Account ${cred.accountId}. Token saved to ${AUTH_FILE}`);
console.log("Next: node worker/check.mjs");
process.exit(0);
