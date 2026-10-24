# Pickup Counter

A self-service snack counter application where customers select products, reserve stock for 120 seconds, pay through a simulated payment webhook, and collect their order through a pickup claim.

## Tech Stack

- **Frontend:** Next.js, React, TypeScript
- **Backend:** NestJS, TypeScript
- **Database:** PostgreSQL
- **ORM:** Prisma
- **Testing:** Jest, ts-jest, real PostgreSQL database
- **Payment simulation:** HMAC-SHA256 signed webhook

All monetary values are stored and processed as integer paise to avoid floating-point rounding errors.

## Features

- Product catalog with prices and available inventory
- Atomic stock reservations when customers place orders
- 120-second reservation expiry
- Automatic availability calculation that excludes expired reservations
- Payment webhook signature verification
- Idempotent payment event processing
- Order review for payment amount mismatches and late payments
- Concurrent-safe pickup claims
- Stock deduction only after a successful pickup claim
- Customer interface with a cart, order status, and countdown
- Automated end-to-end tests using PostgreSQL

## Requirements

Install the following before running the project:

- Docker
- Docker Compose
- Node.js and npm, if running scripts or tests outside Docker

## Run the Application

From the project root, run:

```bash
docker compose up --build
```

The application should be available at:

- **Customer interface:** http://localhost:3000
- **Backend API:** http://localhost:8080

Docker Compose starts PostgreSQL, the backend, and the frontend.

The backend applies database migrations and seeds the product catalog during startup.

To stop the application, press `Ctrl+C`. If you started it in detached mode, use:

```bash
docker compose down
```

The PostgreSQL data is stored in a Docker volume and is retained when containers are stopped.

## Environment Configuration

The backend uses environment variables for the database connection, webhook secret, frontend origin, and server port.

For local development, create `backend/.env` using the example file if one is provided:

```bash
cd backend
npm i
cp .env.example .env
```

If `backend/.env` already exists, edit it rather than overwriting it.

Example local development configuration:

```dotenv
DATABASE_URL="postgresql://pickup_user:local_dev_password@localhost:5432/pickup_counter?schema=public"
TEST_DATABASE_URL="postgresql://pickup_user:local_dev_password@localhost:5432/pickup_test"
PAYMENT_WEBHOOK_SECRET="local-webhook-secret-change-me"
FRONTEND_ORIGIN="http://localhost:3000"
PORT="8080"
```

These values must match the local PostgreSQL and Docker Compose configuration.

**Important:** These are development credentials only. Do not use them in production or commit real secrets to version control.

The test setup uses `TEST_DATABASE_URL` to keep automated tests separate from the development database.

## Try the Customer Flow

1. Start the application with `docker compose up --build`.
2. Open http://localhost:3000.
3. Browse the products and add items to the cart.
4. Place an order.
5. Copy the order ID shown by the application.
6. Simulate payment using the backend payment script.
7. Confirm that the order status updates.
8. Claim the order for pickup.

## Simulate a Payment

The repository includes a payment simulation script that sends a signed webhook to the backend.

From the `backend` directory, configure the environment and run:

```bash
npx tsx -r dotenv/config scripts/simulate-payment.ts <order-id>
```

Replace `<order-id>` with the order ID returned when placing the order.

The simulator and backend must use the same `PAYMENT_WEBHOOK_SECRET`.

The webhook must contain the event ID, order ID, payment amount in the field required by the API contract, and the captured status. Its signature is calculated using HMAC-SHA256 over the exact raw request body.

## Claim an Order for Pickup

After an order has been paid, send a pickup claim request:

```bash
curl -i -X POST "http://localhost:8080/orders/<order-id>/pickup-claim"
```

Replace `<order-id>` with the actual order ID.

A successful claim returns HTTP `201`. A repeated or invalid claim returns HTTP `409`.

The pickup operation is atomic: stock is deducted only once when the order transitions successfully to the picked-up state.

## API Overview

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/products` | Retrieve products and currently available units |
| `POST` | `/orders` | Create an order and reserve inventory |
| `GET` | `/orders/:id` | Retrieve order status and expiry information |
| `POST` | `/payments/webhook` | Receive and validate payment events |
| `POST` | `/orders/:id/pickup-claim` | Claim a paid order for pickup |

### Create an Order

Example request:

```json
{
  "items": [
    {
      "productId": "PRODUCT_ID",
      "quantity": 2
    }
  ]
}
```

The API returns the order ID, total amount, status, expiry information, and the server-calculated `expiresInSeconds` value.

The `idempotencyKey` field may also be provided if supported by the current API implementation.

Orders that cannot be fulfilled because of insufficient inventory should fail with HTTP `409`. The failed request must not leave a partial stock reservation.

### Payment Webhook

The payment endpoint accepts captured payment events signed with the configured webhook secret.

The `X-Signature` header contains the hexadecimal HMAC-SHA256 signature of the exact raw request body.

Repeated event IDs must not process the same payment more than once. Payment amount mismatches require review rather than being marked paid.

Use the exact field names implemented in the API contract when sending payment events.

## Inventory and Reservation Design

### Available Inventory

Available units are calculated from physical stock minus inventory reserved by active orders.

Pending orders count as reservations only while their hold has not expired. Paid but unclaimed orders continue to reserve inventory.

This allows expired holds to stop affecting availability without relying on a separate background expiry job.

The API also updates expired pending orders when relevant order or product endpoints are accessed.

### Atomic Order Creation

Order creation uses a database transaction to prevent overselling.

Product rows are locked in a consistent order before availability is checked and the order is created. If any requested quantity cannot be fulfilled, the transaction fails without leaving partial reservations.

### Payment Idempotency

Webhook event IDs are unique. Duplicate events are acknowledged without applying the payment transition a second time.

The payment amount is validated before an order is marked paid. Amount mismatches are flagged for review.

### Late Payments

A payment captured after a reservation expires must not cause inventory to be oversold.

The application must follow its implemented late-payment policy. If the order can still be fulfilled safely, it may be accepted; otherwise, it should be flagged for manual review and possible refund.

No automatic refund is performed by the simulated payment integration.

### Pickup Claims

Pickup claims are handled using a database-guarded state transition. Concurrent requests cannot successfully claim the same order twice.

The stock deduction and order state change occur in the same transaction.

## Automated Tests

The end-to-end tests use a real PostgreSQL database rather than mocked database calls.

### Configure the Test Database

Start PostgreSQL from the project root:

```bash
docker compose up -d db
```

In `backend/.env`, configure `TEST_DATABASE_URL` to point to the dedicated test database:

```dotenv
TEST_DATABASE_URL="postgresql://pickup_user:local_dev_password@localhost:5432/pickup_test"
```

The test setup checks that the database name ends in `_test` before performing a destructive schema reset.

**Warning:** Test setup may reset the configured test database. Never point `TEST_DATABASE_URL` at your development or production database.

### Run the Tests

From the `backend` directory:

```bash
npm install
npm run test:e2e
```

The end-to-end test configuration runs the suite with a single worker because tests share a database.

### Verified Test Scenarios

The following four tests have been run successfully:

| Scenario | Expected result |
|---|---|
| Ten customers compete for the last two units | Exactly two orders succeed; the other eight fail with HTTP `409` |
| Two simultaneous deliveries of the same payment event | One event is processed and the other is treated as a duplicate |
| A previously processed payment event is replayed | The replay is ignored and the order remains paid |
| Two simultaneous pickup claims | Exactly one claim succeeds; the other returns HTTP `409`; stock is deducted once |

These tests verify important concurrency and idempotency properties against PostgreSQL.

## Assumptions

- All monetary amounts are integer paise.
- Captured payment events represent successful payment attempts.
- Product stock represents physical inventory.
- Active unpaid orders reserve inventory for 120 seconds.
- Paid but unclaimed orders continue to reserve inventory.
- Physical stock is permanently decremented when pickup succeeds.
- A payment amount mismatch requires review.
- Late payments must not cause inventory to be oversold.
- The payment integration is simulated; no real payment provider or automated refund system is connected.
- Authentication and locker-specific authorization are outside the current scope.

## Potential Improvements

- Add database constraints to prevent negative stock.
- Use versioned Prisma migrations for all deployment environments.
- Add automated tests for invalid signatures, amount mismatches, expired orders, and late-payment branches.
- Add an administrative workflow for orders requiring review.
- Integrate a real payment provider and refund workflow.
- Add authentication, authorization, and rate limiting.
- Add frontend component tests and browser-level smoke tests.
- Add structured logging and monitoring for order and payment events.