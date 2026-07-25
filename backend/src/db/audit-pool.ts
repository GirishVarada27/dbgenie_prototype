import pg from "pg"
import { logger } from "../logger.js"

let pool: pg.Pool | null = null

// Separate connection, authenticated as the restricted dbgenie_audit_writer
// role (created in db/init.ts) rather than the DATABASE_URL owner role that
// backend/src/db.ts connects as — this is what makes audit_logs actually
// append-only rather than just documented as append-only. Lazily
// constructed (like secrets/store.ts's key check) so importing this module
// doesn't require the env var to be set until it's actually used.
export function getAuditPool(): pg.Pool {
  if (pool) return pool

  const password = process.env.AUDIT_DB_ROLE_PASSWORD
  const baseUrl = process.env.DATABASE_URL
  if (!password || !baseUrl) {
    throw new Error(
      "AUDIT_DB_ROLE_PASSWORD and DATABASE_URL must both be set. Copy .env.example to .env and generate one.",
    )
  }

  const url = new URL(baseUrl)
  url.username = "dbgenie_audit_writer"
  url.password = password

  pool = new pg.Pool({ connectionString: url.toString() })
  pool.on("error", (err) => {
    logger.error({ err }, "Unexpected error on idle Postgres client (audit pool)")
  })
  return pool
}
