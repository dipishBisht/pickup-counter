# AI Usage Notes

## Tools Used

I used AI assistance during development to help plan and implement parts of the Pickup Counter application. I reviewed the generated suggestions, integrated relevant changes, and ran the application and automated tests to verify behavior.

**AI tools used:** Update this section to name the tools you actually used, such as ChatGPT or Claude.

## How AI Assisted

AI assistance was used for parts of the following development tasks:

- Planning the NestJS backend structure and API endpoints.
- Exploring PostgreSQL concurrency strategies for stock reservations.
- Implementing payment webhook validation and idempotency.
- Designing pickup claims that are safe under concurrent requests.
- Setting up end-to-end tests against a real PostgreSQL database.
- Preparing Docker configuration and project documentation.
- Reviewing implementation decisions and identifying potential edge cases.

The final implementation was tested against the local environment. AI-generated suggestions were not treated as correct without review or verification.

## Example Prompt

One useful prompt was:

> Two clients may send a pickup claim for the same order at the same time. Exactly one request must succeed, and the other must return HTTP 409. Design a solution using PostgreSQL transactions and conditional database updates, without in-memory locks. Include an end-to-end test that sends both requests concurrently against a real PostgreSQL database.

This prompt focused on a specific concurrency requirement and asked for a database-backed solution rather than a process-local lock.

## An AI Mistake I Identified

**Important:** The example below should reflect a mistake that actually occurred during development. Keep it only if it accurately describes your experience.

An issue identified during review was a possible mismatch between the payment webhook's amount field and the assignment's required API contract.

The backend, simulator, and tests can agree with one another while still disagreeing with the external specification. A successful local test therefore does not automatically prove contract compliance.

I learned to compare request fields against the assignment requirements, not just verify that the frontend, backend, and test script work together.

Before submission, the webhook controller, validation DTO, service, simulator, and tests should all be checked for consistent use of the required amount field.

## Verification

I ran the end-to-end test suite against a dedicated PostgreSQL test database.

The four verified tests covered:

1. Ten concurrent customers competing for two available units.
2. Concurrent deliveries of the same payment webhook event.
3. Replaying a previously processed payment event.
4. Concurrent pickup claims for the same paid order.

All four tests passed in the observed run.

The test setup used `pickup_test` rather than the development database. This matters because the test setup resets its configured database before executing the suite.

## Development Decisions

Several important decisions were made during development:

- **Integer money representation:** Prices and totals are stored in paise to avoid floating-point arithmetic errors.
- **Database-backed concurrency:** Stock reservations and pickup claims rely on PostgreSQL transactions and conditional state changes rather than in-memory locks.
- **Idempotent payment processing:** Webhook event IDs are used to prevent duplicate payment processing.
- **Server-authoritative expiry:** The backend provides reservation expiry information; the browser countdown is for display and does not determine whether a payment or pickup is valid.
- **Explicit test isolation:** Automated tests use a separate database whose name ends in `_test`.

## Limitations

The payment provider is simulated, so the application does not perform real payment collection or automatic refunds.

Orders that require payment review need an operational workflow before this system could be used in production.

The project is a take-home assignment implementation, not a production-hardened payment or inventory platform.