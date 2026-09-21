import pg from 'pg';

const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const runtimeUrl = process.env.DATABASE_URL;

if (migrationUrl === undefined || runtimeUrl === undefined) {
  throw new Error('DATABASE_MIGRATION_URL and DATABASE_URL are required.');
}

const runtime = new URL(runtimeUrl);
const roleName = decodeURIComponent(runtime.username);
const rolePassword = decodeURIComponent(runtime.password);

if (!/^[a-z][a-z0-9_]{2,62}$/u.test(roleName) || rolePassword.length < 16) {
  throw new Error('The runtime database role or password does not meet provisioning requirements.');
}

const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;
const quoteLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
const client = new pg.Client({ connectionString: migrationUrl });

try {
  await client.connect();
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
  await client.query(`GRANT incidentbase_runtime TO ${identifier}`);
} finally {
  await client.end();
}
