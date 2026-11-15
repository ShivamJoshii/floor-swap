# Floor Swap — SaaS

Room photo + the store's real product swatch → 3 AI mockups. Prepaid credits per generation.

## Parts
- `supabase/migrations/` — every migration applied to the live project, in order (schema, RLS, plans/billing, marketplace, supplier requests).
- `supabase/functions/` — Edge Functions: `generate` (image render, Google or fal), `billing-checkout`, `billing-portal`, `stripe-webhook`.
  `autotag` fills colour, shade, vibe, look tags, rooms and surfaces for any product or catalogue row that has never been tagged. A pg_cron job calls it every 5 minutes, so bulk imports and new suppliers need nothing extra. Deploy it with JWT verification off (it checks the sweep token or a platform admin itself). Optional `app_settings.tag_model` picks the Google model.
  Usage is counted per image: every version of a room render and every product room photo (`showcase`) takes one image from the monthly allowance, then from top-ups (`consume_images` / `settle_images`; failed images are given back). The allowance runs in monthly windows from `stores.period_start`. `image_usage` is the full history; stores read it through `store_image_history`, and `admin_usage` adds provider cost. Room photos are never made automatically: staff pick products in Builders.
- `web/` — Vite + React app (Create, Proposal, Products, Suppliers, billing, team, admin).

## One-time setup
1. Supabase project → apply the migration (done from Claude or SQL editor).
2. Supabase → Edge Functions → Secrets: `FAL_KEY`, `GEMINI_KEY` (optional, cheaper), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
3. Supabase → Authentication → Providers → Email: turn OFF "Confirm email" if you don't want sign-up emails (free SMTP is rate-limited).
4. Make yourself platform admin after first sign-in:
   `insert into platform_admins (user_id) select id from auth.users where email = 'you@example.com';`
5. Web app env (Netlify → Site → Environment variables, or `.env` locally):
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_KEY` (publishable key)
6. Deploy from GitHub: Netlify → Site → Build & deploy → Link repository. `netlify.toml` sets base `web`, build `npx vite build`, publish `dist`. Every push to `main` deploys.

## Knobs (no code changes)
- `app_settings`: `model` (fal model id), `images_per_generation`, `credits_per_generation`, `trial_credits`, `provider_cost_cents_per_image`.
- `credit_packs`: the 3 tiers (credits, price_cents, currency).

## Selling credits before Stripe
Admin tab → Add credits → pick the store and pack. Logged in the ledger with reason `purchase`.
