import pg from "pg"
import { drizzle } from "drizzle-orm/node-postgres"
import * as schema from "./db/schema.js"
import { logger } from "./logger.js"

const { Pool } = pg

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env and add your Neon connection string.")
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

// node-postgres emits 'error' on the Pool itself when an *idle* client's
// connection is dropped server-side — with no listener, that's an
// unhandled 'error' event, which Node treats as an uncaught exception and
// crashes the whole process. This isn't hypothetical: it took down the API
// process during Stage 4 testing. Every pg.Pool this app creates needs one
// of these (see also db/audit-pool.ts, connectors/postgres-connector.ts).
pool.on("error", (err) => {
  logger.error({ err }, "Unexpected error on idle Postgres client (main pool)")
})

export const db = drizzle(pool, { schema })
