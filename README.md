# Pickup Counter

Self-service snack counter: pick items, hold stock for 120 s, pay by (simulated) UPI webhook, collect from a locker.
NestJS + Prisma + PostgreSQL backend, Next.js customer screen. TypeScript throughout. Money is always integer paise.

## Run everything (one command)

```bash
docker compose up --build
```

- Customer screen: http://localhost:3000
- API: http://localhost:8080
- The backend container applies the schema (`prisma db push`) and seeds 5 products on start.

## Try the flow

1. Open http://localhost:3000, add items, **Place order** (copy the order reference).
2. Simulate the payment :
   ```bash
   cd backend && cp .env.example .env
   npx tsx -r dotenv/config scripts/simulate-payment.ts <reference-id>
   ```
3. Locker claim: `curl -X POST http://localhost:8080/orders/<orderId>/pickup-claim` (201 once, then 409).

## Run the tests

Tests use a **real PostgreSQL** database (never mocks).

```bash
docker compose up -d db        # Postgres on localhost:5432
cd backend
cp .env.example .env
npm install
npm run test:e2e
```

The run creates `pickup_counter_test` automatically (or set `TEST_DATABASE_URL`), pushes the schema, and truncates tables between tests, so your dev data is untouched. Tests run in band (one worker) because they share one database.

What they prove:

| Requirement | Test |
|---|---|
| 10 customers, last 2 units | exactly 2 orders created/held, 8 get 409, DB holds sum to 2 |
| Multi-item order, one line short | 409 and nothing held (atomic) |
| Same webhook twice / concurrently | 4 deliveries -> 1 processed, 1 `WebhookEvent` row, order PAID |
| Bad / missing signature | 401, order untouched |
| Wrong amount | `NEEDS_REVIEW` |
| Two simultaneous pickup claims | statuses `[201, 409]`, stock reduced exactly once |
| Unpaid / expired / needs_review claim | 409, stock unchanged |
| Late payment (both branches) | see below |

## Design decisions

**Money.** Integer paise in the DB and all arithmetic. The UI divides by 100 only for display.

**Holds without a reaper job.** Availability is *computed*: `stock − units in (PENDING and not yet expired) orders − units in PAID-but-unclaimed orders`. An expired hold therefore stops counting the instant its time passes, with no background job to lag or fail. `GET /products` and `GET /orders/:id` also persist the `PENDING → EXPIRED` status lazily.

**No overselling.** `POST /orders` runs in one transaction that takes `SELECT … FOR UPDATE` on each requested product row (in sorted id order, so no deadlocks), then re-counts holds and creates the order. Concurrent orders for the same product queue on that lock, so each sees the previous one's hold. Any shortfall throws and rolls back the whole transaction (409, nothing held). An optional `idempotencyKey` makes client retries safe.

**Webhook.** HMAC-SHA256 is checked over the exact raw bytes (`rawBody`) with a timing-safe compare. Idempotency is a unique `eventId` row inserted in the same transaction as the state change; the order row is locked first so racing deliveries serialize, and a unique-violation race resolves to "duplicate". Wrong amount → `NEEDS_REVIEW`. Non-`captured` statuses are acknowledged and ignored.

**Late payment (the open question).** A valid, correct-amount capture arriving after the hold expired is **honoured if the units are still free, otherwise sent to `NEEDS_REVIEW`**. After locking the product rows, we re-check availability against everyone else's holds: if it fits, the order becomes `PAID` and the units are held for pickup again; if someone has bought them, the order becomes `NEEDS_REVIEW` for a manual refund. *Why:* the customer really paid, so rejecting a payment we could fulfil is needlessly hostile; but we must never oversell, so when stock is gone a human decides (refund vs. substitute). Auto-refunding is out of scope with no payment provider. Both branches are tested.

**Pickup.** One conditional `UPDATE … WHERE status='PAID' AND claimedAt IS NULL`. Postgres row locking lets exactly one concurrent claimer match; the other sees 0 rows and gets 409. Stock is decremented in the same transaction, so a claim can't half-apply.

**Countdown.** The server returns `expiresInSeconds` measured at send time. The browser anchors that to its own monotonic `performance.now()` and counts down from there, so a customer-screen clock that is minutes wrong has no effect. It re-anchors on every poll (every 3 s). Error is limited to network latency (typically well under a second).

## Assumptions

- Payment amounts are whole paise; `status: "captured"` is the only payment-success status.
- Paid-but-unclaimed orders keep their units reserved; "stock" is physical units, decremented permanently on pickup.
- Orders are single-use; there is no auth (locker and counter are trusted clients).
- `idempotencyKey` is optional; the spec's plain `{items}` body works.
- Re-seeding refreshes prices only, never stock.

## What I'd do next

- Add a DB `CHECK (stock >= 0)` and real Prisma migrations instead of `db push`.
- Auto-refund/notify flow for `NEEDS_REVIEW`; admin screen for those orders.
- Locker authentication (API key per locker) and rate limiting.
- Component tests for the cart/countdown (fake timers + skewed `Date`) and a Playwright smoke test.
- Structured logging and metrics for webhook outcomes.
