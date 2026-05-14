# LAUNCH NOW — 30-minute click-by-click path

## Step 1 — Spin up Neon Postgres (3 min)
1. console.neon.tech → New Project → `openheab-production`
2. Region: `aws-us-east-1`
3. Copy connection string → paste into `.env.production` as `DATABASE_URL`

## Step 2 — Stripe (5 min, optional)
1. dashboard.stripe.com/apikeys → copy `sk_test_...` → `STRIPE_SECRET_KEY`
2. dashboard.stripe.com/webhooks → Add endpoint `https://openheab.com/v1/_webhooks/stripe`
3. Listen for `checkout.session.completed`, `invoice.payment_succeeded`
4. Copy signing secret → `STRIPE_WEBHOOK_SECRET`
5. Products → create "OpenHeab Pro" $19/mo → copy price ID → `STRIPE_PRICE_PRO_MONTHLY`

## Step 3 — Anthropic API key (1 min)
console.anthropic.com/settings/keys → Create → paste into `ANTHROPIC_API_KEY`

## Step 4 — Save env
```bash
cp .env.production.template .env.production
# Fill in DATABASE_URL, STRIPE_*, ANTHROPIC_API_KEY
# Generate master keys: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Step 5 — Deploy (5 min)
```bash
npm install -g vercel
vercel login
chmod +x deploy.sh
./deploy.sh
```

Script will: verify env, run tests, migrate Neon, push 14 env vars to Vercel, deploy, smoke-test.

## Step 6 — Point openheab.com at Vercel (3 min, if needed)
Vercel → Settings → Domains → Add `openheab.com` → set DNS records at registrar.

## Step 7 — Submit MCP to registries (5 min)
- Smithery: https://smithery.ai/new → submit `https://openheab.com/.well-known/mcp.json`
- mcp.run: https://mcp.run/submit → submit `https://openheab.com/mcp/manifest`

## Step 8 — Post launch
- HN Show HN (Tuesday 9am ET best time)
- Twitter thread
- Anthropic Discord #show-and-tell

Copy text in `launch/LAUNCH_POSTS.md`.

## Step 9 — Watch logs
```bash
vercel logs --follow
```

Reply to every HN comment in the first 6 hours.

Total realistic time: 30-45 minutes if accounts exist, ~90 minutes from scratch.
