// Engine-agnostic connector surface. PostgresConnector (postgres-connector.ts)
// is the only implementation in Phase 1 — Phase 2 adds MongoConnector /
// SqlServerConnector / SapIqConnector against this same interface so
// calling code (worker jobs, routes) never branches on engine type.
export interface DatabaseConnector {
  testConnection(): Promise<ConnectionResult>
  collectMetrics(): Promise<MetricSample[]>
  runHealthCheck(): Promise<HealthReport>
  getExplainPlan(sql: string): Promise<QueryPlan>
  listTablesAndIndexes(): Promise<SchemaSnapshot>
  // Added for Stage 3's Root Cause Agent — collectMetrics() only returns
  // aggregate counts, not per-query text, which the agent needs as
  // diagnostic context.
  getRecentQueryActivity(): Promise<QueryActivitySample[]>
  // Added for Stage 4's backup validation — a freshly created database
  // (e.g. a brand-new Neon branch) has "cold" planner statistics even
  // though its actual data is a real copy, so listTablesAndIndexes()'s
  // row counts read as ~0 for everything until stats are (re)collected.
  // Postgres: runs ANALYZE. A hypothetical non-Postgres connector can no-op
  // this if the engine doesn't have an equivalent stale-stats problem.
  refreshStatistics(): Promise<void>
  close(): Promise<void>
}

export interface ConnectionResult {
  ok: boolean
  message: string
  serverVersion?: string
}

export interface MetricSample {
  metricName: string
  value: number
}

export interface HealthReport {
  status: "ok" | "degraded" | "down"
  checkedAt: string
  details: Record<string, unknown>
}

export interface QueryPlan {
  plan: unknown
}

export interface IndexInfo {
  name: string
  definition: string
}

export interface TableInfo {
  schema: string
  name: string
  approxRowCount: number
  indexes: IndexInfo[]
}

export interface SchemaSnapshot {
  tables: TableInfo[]
}

export interface QueryActivitySample {
  runningForSeconds: number
  query: string
}
