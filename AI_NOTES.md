# AI notes

> Draft — edit this so it reflects what you actually did. Delete anything untrue.

**Tools used:** Claude (chat) for scaffolding the NestJS/Prisma code, the concurrency design, the test suite and the docs; I reviewed, ran and adjusted everything.

**What I used it for:** drafting services and controllers, the locking strategy for stock holds, the Jest + real-Postgres test setup, Docker files, and README/AI notes.

**A prompt that worked well:**
> "Two lockers can POST /orders/:id/pickup-claim for the same order at the same instant. Exactly one must succeed and the other must get 409. Design it with PostgreSQL and Prisma, no in-memory locks, and write a test that fires both requests concurrently against a real database."

It produced a conditional `updateMany` (`WHERE status='PAID' AND claimedAt IS NULL`) and a `Promise.all` test, which I then ran.

**Something the AI got wrong (and how I noticed):**
1. *Contract mismatch.* The generated webhook controller and simulator used `amount`, but the brief specifies `amountPaise`. They worked with each other, so my own manual test passed. I only caught it when re-reading the brief against the code in an audit. Fixed in the controller, service, script and tests.
2. *Late payments silently ignored.* The first version only handled `PENDING` orders, so a valid payment for an already-`EXPIRED` order was recorded and then did nothing. A test for the late-payment case exposed it; the service now re-checks stock and either pays or flags for review.
3. *Jest wouldn't start.* The Prisma client generated as ESM and crashed Jest before any test ran. Setting `moduleFormat = "cjs"` in the generator fixed it.
4. *Countdown trusted the browser clock.* It compared the server's absolute `expiresAt` with `Date.now()`, which breaks on a skewed clock. Replaced with server-measured `expiresInSeconds` anchored to `performance.now()`.
