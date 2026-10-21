# Floor Swap — SaaS

Room photo + the store's real product swatch → 3 AI mockups. Prepaid credits per generation.

## Parts
- `supabase/migrations/0001_init.sql` — stores, members, invites, products, renders, credit ledger, packs, settings, RLS, storage buckets.
- `supabase/functions/generate/index.ts` — Edge Function: auth → credit check → fal image edit → store outputs. Refunds the credit if the provider fails.
- `web/` — Vite + React staff app (login, generate, products, credits, team, admin).

## One-time setup
1. Supabase project → apply the migration (done from Claude or SQL editor).
2. Supabase → Edge Functions → Secrets: add `FAL_KEY` (from fal.ai dashboard).
3. Supabase → Authentication → Providers → Email: turn OFF "Confirm email" if you don't want sign-up emails (free SMTP is rate-limited).
4. Make yourself platform admin after first sign-in:
   `insert into platform_admins (user_id) select id from auth.users where email = 'you@example.com';`
5. Web app env (Netlify → Site → Environment variables, or `.env` locally):
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_KEY` (publishable key)
6. Deploy `web/` to Netlify: base `web`, build `npm run build`, publish `dist` (netlify.toml already says this).

## Knobs (no code changes)
- `app_settings`: `model` (fal model id), `images_per_generation`, `credits_per_generation`, `trial_credits`, `provider_cost_cents_per_image`.
- `credit_packs`: the 3 tiers (credits, price_cents, currency).

## Selling credits before Stripe
Admin tab → Add credits → pick the store and pack. Logged in the ledger with reason `purchase`.
