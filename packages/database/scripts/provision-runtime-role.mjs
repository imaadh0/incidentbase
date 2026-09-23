import pg from 'pg';

const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const runtimeUrl = process.env.DATABASE_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;

if (migrationUrl === undefined || runtimeUrl === undefined || workerUrl === undefined) {
  throw new Error('DATABASE_MIGRATION_URL, DATABASE_URL, and WORKER_DATABASE_URL are required.');
}

const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;
const quoteLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
const client = new pg.Client({ connectionString: migrationUrl });

try {
  await client.connect();
  await provisionLogin(runtimeUrl, 'incidentbase_runtime');
  await provisionLogin(workerUrl, 'incidentbase_worker');
} finally {
  await client.end();
}

async function provisionLogin(connectionString, groupRole) {
  const runtime = new URL(connectionString);
  const roleName = decodeURIComponent(runtime.username);
  const rolePassword = decodeURIComponent(runtime.password);

  if (
    !/^[a-z][a-z0-9_]{2,62}$/u.test(roleName) ||
    roleName === groupRole ||
    rolePassword.length < 16
  ) {
    throw new Error('A runtime database role or password does not meet provisioning requirements.');
  }

  const existing = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [roleName]);
  const identifier = quoteIdentifier(roleName);
  const password = quoteLiteral(rolePassword);

  if (existing.rowCount === 0) {
    await client.query(
      `CREATE ROLE ${identifier} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS PASSWORD ${password}`,
    );
  } else {
    await client.query(
      `ALTER ROLE ${identifier} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS PASSWORD ${password}`,
    );
  }
  await client.query(`GRANT ${quoteIdentifier(groupRole)} TO ${identifier}`);
}
