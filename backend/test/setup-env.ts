import 'dotenv/config';

// Runs before every test file (and from global-setup). Points the app at a *test* database.
// Safety: the database name must end in "_test", because tests delete all rows.
const explicit = process.env.TEST_DATABASE_URL;
const base = explicit ?? process.env.DATABASE_URL;

if (!base) {
  throw new Error('Set TEST_DATABASE_URL (or DATABASE_URL in backend/.env).');
}

const url = new URL(base);
if (!explicit && !url.pathname.endsWith('_test')) {
  url.pathname += '_test'; // e.g. /pickup_counter -> /pickup_counter_test
}
if (!url.pathname.endsWith('_test')) {
  throw new Error(
    `Refusing to run tests on database "${url.pathname.slice(1)}": the name must end with _test.`,
  );
}

process.env.DATABASE_URL = url.toString();
process.env.PAYMENT_WEBHOOK_SECRET = 'test_webhook_secret';
