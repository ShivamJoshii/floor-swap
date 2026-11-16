# Floor Swap image worker (ChatGPT route)

Generates renders through a ChatGPT subscription instead of a paid image API.
Runs on one always-on machine. No dependencies; needs Node 20 or newer.

    node worker/login.mjs    # once: sign in with ChatGPT in the browser
    node worker/check.mjs    # proves token refresh works and one image comes back

The login is saved to `~/.floor-swap-worker/auth.json` and refreshes itself.
Signing out of ChatGPT everywhere, or changing the password, ends it: run `login.mjs` again.

Status: step 1 (login + refresh + test image). The queue worker and the `generate` hookup come next.
