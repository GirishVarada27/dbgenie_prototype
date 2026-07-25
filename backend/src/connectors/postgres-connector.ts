import pg from "pg"
import type {
  ConnectionResult,
  DatabaseConnector,
  HealthReport,
  MetricSample,
  QueryActivitySample,
  QueryPlan,
  SchemaSnapshot,
} from "./types.js"
import { logger } from "../logger.js"

export interface PostgresConnectionConfig {
  host: string
  port: number
  database: string
  user: string
  password: string
  sslMode: string
}

export class PostgresConnector implements DatabaseConnector {
  private pool: pg.Pool

  constructor(config: PostgresConnectionConfig) {
    this.pool = new pg.Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.sslMode === "disable" ? false : { rejectUnauthorized: false },
      max: 3,
      connectionTimeoutMillis: 8000,
    })

    // A monitored database can drop an idle connection at any time (it's
    // someone else's database, outside our control) — without this,
    // node-postgres treats that as an unhandled 'error' event and crashes
    // the whole process. This module is instantiated once per request/job
    // across the entire app (routes, metrics-worker, root-cause-context,
    // backup-validation-worker), so this one missing handler was a
    // process-wide reliability bug, not a narrow edge case.
    this.pool.on("error", (err) => {
      logger.error({ err, host: config.host, database: config.database }, "Unexpected error on idle client (monitored DB pool)")
    })
  }

  async testConnection(): Promise<ConnectionResult> {
    try {
      const result = await this.pool.query<{ version: string }>("SELECT version()")
      return { ok: true, message: "Connected", serverVersion: result.rows[0]?.version }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : "Unknown connection error" }
    }
  }

  // Targets the stat views named in the Stage 2 scope: pg_stat_activity,
  // pg_stat_database, pg_stat_bgwriter, pg_locks. Named metrics
  // (active_connections, max_connections, longest_running_query_seconds)
  // are the ones the worker's anomaly detection reads directly.
  async collectMetrics(): Promise<MetricSample[]> {
    const samples: MetricSample[] = []

    const activity = await this.pool.query<{ state: string | null; count: string }>(
      `SELECT state, count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() GROUP BY state`,
    )
    let activeConnections = 0
    for (const row of activity.rows) {
      const count = Number(row.count)
      if (row.state === "active") activeConnections = count
      samples.push({ metricName: `pg_stat_activity.${row.state ?? "unknown"}`, value: count })
    }
    samples.push({ metricName: "active_connections", value: activeConnections })

    // `SHOW max_connections` returns a column named after the setting, not
    // "setting" — query pg_settings directly instead of parsing SHOW output.
    const maxConn = await this.pool.query<{ setting: string }>(
      "SELECT setting FROM pg_settings WHERE name = 'max_connections'",
    )
    samples.push({ metricName: "max_connections", value: Number(maxConn.rows[0]?.setting ?? 0) })

    const dbStats = await this.pool.query<Record<string, string | number>>(
      `SELECT xact_commit, xact_rollback, blks_read, blks_hit, tup_returned, tup_fetched, tup_inserted, tup_updated, tup_deleted
       FROM pg_stat_database WHERE datname = current_database()`,
    )
    if (dbStats.rows[0]) {
      for (const [key, value] of Object.entries(dbStats.rows[0])) {
        samples.push({ metricName: `pg_stat_database.${key}`, value: Number(value) })
      }
    }

    const bgwriter = await this.pool.query<Record<string, string | number>>(`SELECT * FROM pg_stat_bgwriter`)
    if (bgwriter.rows[0]) {
      for (const [key, value] of Object.entries(bgwriter.rows[0])) {
        const num = Number(value)
        if (!Number.isNaN(num)) samples.push({ metricName: `pg_stat_bgwriter.${key}`, value: num })
      }
    }

    const locks = await this.pool.query<{ count: string }>(`SELECT count(*) FROM pg_locks`)
    samples.push({ metricName: "pg_locks.count", value: Number(locks.rows[0]?.count ?? 0) })

    const longestQuery = await this.pool.query<{ seconds: number | null }>(
      `SELECT EXTRACT(EPOCH FROM (now() - query_start)) AS seconds
       FROM pg_stat_activity
       WHERE state = 'active' AND pid <> pg_backend_pid() AND query_start IS NOT NULL
       ORDER BY query_start ASC LIMIT 1`,
    )
    samples.push({ metricName: "longest_running_query_seconds", value: longestQuery.rows[0]?.seconds ?? 0 })

    return samples
  }

  async runHealthCheck(): Promise<HealthReport> {
    const conn = await this.testConnection()
    return {
      status: conn.ok ? "ok" : "down",
      checkedAt: new Date().toISOString(),
      details: conn.ok ? { serverVersion: conn.serverVersion } : { error: conn.message },
    }
  }

  // Read-only by construction: EXPLAIN without ANALYZE never executes the
  // statement, even for INSERT/UPDATE/DELETE — only plans it. Never add
  // ANALYZE here (see Stage 4 scope: "never run EXPLAIN ANALYZE against
  // production, since ANALYZE actually executes the query").
  async getExplainPlan(sql: string): Promise<QueryPlan> {
    const result = await this.pool.query(`EXPLAIN (FORMAT JSON) ${sql}`)
    return { plan: result.rows[0]?.["QUERY PLAN"] }
  }

  async listTablesAndIndexes(): Promise<SchemaSnapshot> {
    const tables = await this.pool.query<{ schemaname: string; tablename: string; n_live_tup: string }>(
      `SELECT schemaname, relname AS tablename, n_live_tup
       FROM pg_stat_user_tables
       ORDER BY schemaname, relname`,
    )

    const indexes = await this.pool.query<{
      schemaname: string
      tablename: string
      indexname: string
      indexdef: string
    }>(
      `SELECT schemaname, tablename, indexname, indexdef
       FROM pg_indexes
       WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`,
    )

    return {
      tables: tables.rows.map((t) => ({
        schema: t.schemaname,
        name: t.tablename,
        approxRowCount: Number(t.n_live_tup),
        indexes: indexes.rows
          .filter((i) => i.schemaname === t.schemaname && i.tablename === t.tablename)
          .map((i) => ({ name: i.indexname, definition: i.indexdef })),
      })),
    }
  }

  // Query text, not just aggregate counts — used by the Root Cause Agent
  // (Stage 3) as diagnostic context; collectMetrics() intentionally stays
  // aggregate-only since it's persisted every 30s and raw query text isn't
  // needed for anomaly detection.
  async getRecentQueryActivity(): Promise<QueryActivitySample[]> {
    const result = await this.pool.query<{ seconds: number; query: string }>(
      `SELECT EXTRACT(EPOCH FROM (now() - query_start)) AS seconds, query
       FROM pg_stat_activity
       WHERE state = 'active' AND pid <> pg_backend_pid() AND query_start IS NOT NULL
       ORDER BY query_start ASC
       LIMIT 10`,
    )
    return result.rows.map((r) => ({ runningForSeconds: Math.round(r.seconds), query: r.query }))
  }

  // Plain ANALYZE (no table list) refreshes planner statistics for every
  // table in the database — cheap at this app's table sizes, and what
  // makes listTablesAndIndexes() report real counts on a database whose
  // stats haven't been collected yet (e.g. a just-created Neon branch).
  async refreshStatistics(): Promise<void> {
    await this.pool.query("ANALYZE")
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
