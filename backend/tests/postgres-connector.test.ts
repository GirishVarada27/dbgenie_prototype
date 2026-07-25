import "../src/load-env.js"
import { beforeAll, describe, expect, it } from "vitest"
import { PostgresConnector, type PostgresConnectionConfig } from "../src/connectors/postgres-connector.js"

// No Docker available in this environment for a testcontainers/docker-compose
// Postgres, so these run as integration tests against a real, reachable
// Postgres instead — defaults to the app's own DATABASE_URL. Point
// TEST_MONITORED_DATABASE_URL at a separate database to isolate these from
// app data if that ever becomes a concern.
function connectionConfigFromUrl(rawUrl: string): PostgresConnectionConfig {
  const url = new URL(rawUrl)
  const sslMode = url.searchParams.get("sslmode") ?? "require"
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database: url.pathname.replace(/^\//, ""),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    sslMode,
  }
}

const testUrl = process.env.TEST_MONITORED_DATABASE_URL || process.env.DATABASE_URL

describe.skipIf(!testUrl)("PostgresConnector", () => {
  let connector: PostgresConnector

  beforeAll(() => {
    connector = new PostgresConnector(connectionConfigFromUrl(testUrl!))
  })

  it("testConnection succeeds against a real database", async () => {
    const result = await connector.testConnection()
    expect(result.ok).toBe(true)
    expect(result.serverVersion).toMatch(/PostgreSQL/)
  })

  it("testConnection fails gracefully with bad credentials", async () => {
    const config = connectionConfigFromUrl(testUrl!)
    const badConnector = new PostgresConnector({ ...config, password: "definitely-wrong-password" })
    const result = await badConnector.testConnection()
    expect(result.ok).toBe(false)
    expect(result.message).toBeTruthy()
    await badConnector.close()
  })

  it("collectMetrics returns the named samples anomaly detection depends on", async () => {
    const samples = await connector.collectMetrics()
    const byName = new Map(samples.map((s) => [s.metricName, s.value]))

    expect(byName.has("active_connections")).toBe(true)
    expect(byName.has("max_connections")).toBe(true)
    expect(byName.get("max_connections")).toBeGreaterThan(0)
    expect(byName.has("longest_running_query_seconds")).toBe(true)
    expect(byName.has("pg_locks.count")).toBe(true)
  })

  it("runHealthCheck reports ok for a reachable database", async () => {
    const report = await connector.runHealthCheck()
    expect(report.status).toBe("ok")
    expect(report.checkedAt).toBeTruthy()
  })

  it("getExplainPlan returns a plan without executing the query", async () => {
    const plan = await connector.getExplainPlan("SELECT 1 AS one")
    expect(plan.plan).toBeTruthy()
  })

  it("listTablesAndIndexes returns a schema snapshot shape", async () => {
    const snapshot = await connector.listTablesAndIndexes()
    expect(Array.isArray(snapshot.tables)).toBe(true)
    for (const table of snapshot.tables) {
      expect(typeof table.name).toBe("string")
      expect(Array.isArray(table.indexes)).toBe(true)
    }
  })

  it("refreshStatistics runs ANALYZE without throwing", async () => {
    await expect(connector.refreshStatistics()).resolves.toBeUndefined()
  })
})
