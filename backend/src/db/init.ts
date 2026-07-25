import path from "node:path"
import { fileURLToPath } from "node:url"
import { getMigrations } from "better-auth/db/migration"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { auth } from "../auth.js"
import { db, pool } from "../db.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// backend/src/db/init.ts (or backend/dist/db/init.js) -> backend/drizzle
const migrationsFolder = path.join(__dirname, "..", "..", "drizzle")

// Arbitrary constant — just needs to be the same value everywhere initDb()
// is called from. pg_advisory_lock keys are per-database, not per-table, so
// one key is enough to serialize the whole init sequence below.
const INIT_LOCK_KEY = 84130001

function getAuditPassword(): string {
  const password = process.env.AUDIT_DB_ROLE_PASSWORD
  if (!password) {
    throw new Error("AUDIT_DB_ROLE_PASSWORD is not set. Copy .env.example to .env and generate one.")
  }
  return password
}

// Runs on every boot (from both the API and the worker entrypoints) so a
// fresh database is ready after `npm run dev` / `npm start` alone — no
// separate manual migration step for the user to remember. Because two
// processes can boot at nearly the same time (e.g. Render starting the web
// service and the background worker together) and both call this, the
// whole sequence runs under a Postgres advisory lock — without it, two
// concurrent `drizzle-orm` migration runs against a fresh database can race
// and throw a duplicate-object error even though each run is individually
// transactional. Order matters: Better Auth owns user/session/organization/
// two-factor tables, so its migrations run before the Drizzle migrations
// for app tables that (loosely) reference org/user ids.
export async function initDb() {
  const client = await pool.connect()

  try {
    await client.query("SELECT pg_advisory_lock($1)", [INIT_LOCK_KEY])

    await client.query("CREATE EXTENSION IF NOT EXISTS vector")
    // pgcrypto backs the prototype's column-level encryption for
    // monitored-DB credentials — see secrets/store.ts.
    await client.query("CREATE EXTENSION IF NOT EXISTS pgcrypto")

    const { runMigrations } = await getMigrations(auth.options)
    await runMigrations()

    await migrate(db, { migrationsFolder })

    // Append-only audit_logs, enforced at the DB role level rather than
    // just in application code: a dedicated role gets INSERT/SELECT only,
    // UPDATE/DELETE explicitly revoked (redundant with a fresh role's
    // default-deny, but stated explicitly so intent survives even if
    // something else later GRANTs broader access to PUBLIC). The app's
    // normal pool (db.ts, connected as the DATABASE_URL owner role) never
    // writes here — only middleware/audit-log.ts's separate pool does, via
    // this restricted role. DO blocks can't take bound parameters, so the
    // password is interpolated directly; safe here because it only ever
    // comes from our own generated hex secret (AUDIT_DB_ROLE_PASSWORD),
    // never user input.
    const auditPassword = getAuditPassword()
    await client.query(`
      DO $do$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dbgenie_audit_writer') THEN
          CREATE ROLE dbgenie_audit_writer LOGIN PASSWORD '${auditPassword}';
        ELSE
          ALTER ROLE dbgenie_audit_writer WITH LOGIN PASSWORD '${auditPassword}';
        END IF;
      END
      $do$;
    `)
    await client.query("GRANT USAGE ON SCHEMA public TO dbgenie_audit_writer")
    await client.query("GRANT INSERT, SELECT ON audit_logs TO dbgenie_audit_writer")
    await client.query("REVOKE UPDATE, DELETE ON audit_logs FROM dbgenie_audit_writer")
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [INIT_LOCK_KEY])
    client.release()
  }
}
