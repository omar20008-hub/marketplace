# Billing setup (Stripe)

Paid plans are sold through Stripe Checkout. Cards (Visa, Mastercard) and Apple
Pay are taken by Stripe; the platform never sees a card number. Until the steps
below are done, `/pricing` says payments are not set up and no one can upgrade.
Nothing here changes existing users: everyone stays on their current plan.

Code: `src/lib/billing.ts`, `src/app/api/billing/*`, `src/app/(app)/pricing/page.tsx`.

## 1. Plans in the database

The plan limits are read from the `Plan` table. The intended values:

| id | name | price / month | runs | storage | folders | indexed files |
|---|---|---|---|---|---|---|
| free | Free | 0 | 50 | 1 GB | 1 | 200 |
| pro | Pro | 20 USD | 1,000 | 5 GB | 5 | 5,000 |
| team | Team | 100 USD | 5,000 | 20 GB | 20 | 50,000 |

Before changing production, look at who is affected. Read-only:

```sql
-- Users on a paid plan, and how much of their storage they already use.
SELECT u.email, u."planId",
       COALESCE(SUM(a."sizeBytes"), 0) AS "usedBytes",
       p."storageBytes" AS "newLimitBytes"
FROM "User" u
JOIN "Plan" p ON p.id = u."planId"
LEFT JOIN "Run" r ON r."userId" = u.id
LEFT JOIN "Artifact" a ON a."runId" = r.id
WHERE u."planId" IN ('pro', 'team')
GROUP BY u.id, u.email, u."planId", p."storageBytes"
ORDER BY u.email;
```

Anyone whose `usedBytes` is above their new limit keeps their files, but cannot
save new results until they remove some. Decide whether to tell them first.

Then update the prices and limits, inside a transaction, after the check above:

```sql
BEGIN;
UPDATE "Plan" SET "priceMonthly" = 20,  "storageBytes" = 5000000000  WHERE id = 'pro';
UPDATE "Plan" SET "priceMonthly" = 100, "storageBytes" = 20000000000 WHERE id = 'team';
SELECT id, "priceMonthly", "storageBytes" FROM "Plan" WHERE id IN ('pro', 'team');
-- Check the three rows, then:
COMMIT;   -- or ROLLBACK;
```

## 2. Stripe account and products

1. In Stripe, create two **recurring monthly** prices: "Pro" at 20 USD and
   "Team" at 100 USD. Copy each price id (`price_…`).
2. Settings → Payment methods: turn on **Cards** and **Apple Pay**.
3. Apple Pay: register the domain `marketplace-production-3f79.up.railway.app`
   (or your own domain) in the Apple Pay settings Stripe shows, and verify it.
4. Settings → Billing → Customer portal: turn it on, and allow customers to
   cancel and to switch between Pro and Team.

## 3. Webhook

Developers → Webhooks → Add endpoint:

- URL: `https://<your domain>/api/billing/webhook`
- Events: `checkout.session.completed`, `customer.subscription.created`,
  `customer.subscription.updated`, `customer.subscription.deleted`

Copy the signing secret (`whsec_…`).

## 4. Railway variables

Set these on the `marketplace` service (never in the repository or in chat):

| Variable | Value |
|---|---|
| `STRIPE_SECRET_KEY` | the secret key (`sk_live_…`, or `sk_test_…` to try first) |
| `STRIPE_WEBHOOK_SECRET` | the endpoint's signing secret (`whsec_…`) |
| `STRIPE_PRICE_PRO` | the Pro price id (`price_…`) |
| `STRIPE_PRICE_TEAM` | the Team price id (`price_…`) |

Redeploy after saving. Billing switches on only when the secret key and both
price ids are set.

## 5. Check it works

Use Stripe's **test mode** first (test keys, test card `4242 4242 4242 4242`).

1. Sign in as a test user, open `/pricing`, choose Pro.
2. Pay on Stripe's page. You return to `/pricing` with "Thank you…".
3. The plan changes once Stripe sends the webhook (usually seconds). Check the
   user's plan on the Plans page or in the database.
4. Open "Manage or cancel subscription", cancel, and check the user is back on Free.
5. In Stripe → Webhooks, every event should show a 2xx response. A 400 means the
   signing secret is wrong; a 500 means the platform failed to apply the event
   (the server log names the event type).

When test mode works, repeat with live keys and live prices.

## What the platform guarantees

- A plan changes only from a signed webhook event, never from the browser.
- A failed renewal or a cancellation returns the user to Free.
- A user whose storage is full cannot start a run; the run is refused before
  anything is spent.
