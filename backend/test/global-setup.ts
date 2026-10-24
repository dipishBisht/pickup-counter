import './setup-env';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { Client } from 'pg';

// Runs once before all tests: creates the test database if needed and (re)creates the schema.
export default async function globalSetup() {
  const url = new URL(process.env.DATABASE_URL!);
  const dbName = url.pathname.slice(1);

  const adminUrl = new URL(url.toString());
  adminUrl.pathname = '/postgres';
  adminUrl.search = '';

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const exists = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [dbName],
    );
    if (exists.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await admin.end();
  }

  execSync('npx prisma db push --force-reset', {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'inherit',
    env: process.env,
  });
}
