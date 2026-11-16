# Floor Swap image worker (ChatGPT route)

Generates renders through a ChatGPT subscription instead of a paid image API.
Runs on one always-on machine. No dependencies; needs Node 20 or newer. Outbound HTTPS only.

    node worker/login.mjs                              # once: sign in with ChatGPT in the browser
    node worker/check.mjs                              # proves token refresh works and an image comes back
    node worker/setup.mjs --url <supabase url> --key <publishable key>   # writes config, prints WORKER HASH
    bash worker/install-mac.sh                         # runs it as a background service (starts at login, restarts itself)

How it fits together:

- `generate` (Supabase function) queues a row in `codex_jobs` for stores listed in `app_settings.codex_store_ids`,
  but only while `codex_worker.last_seen` is fresh and `ok` is true. Otherwise it uses the normal provider.
- The worker claims the job, generates the image, uploads it with a signed URL and marks the job done.
- If the worker fails or is slower than `app_settings.codex_wait_seconds`, `generate` falls back to the normal provider.
- The worker authenticates with a secret whose sha256 is stored in `codex_worker.secret_hash`. It has no service key.

Files on the machine, all in `~/.floor-swap-worker/`: `auth.json` (ChatGPT login, refreshes itself),
`config.json` (project URL, publishable key, worker secret), `worker.log`.

Signing out of ChatGPT everywhere, or changing the password, ends the login: run `login.mjs` again.
Stop the service: `launchctl bootout gui/$(id -u)/ca.mybuilder.floor-swap-worker`
