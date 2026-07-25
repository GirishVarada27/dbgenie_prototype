import { and, desc, eq, lte } from "drizzle-orm"
import { db } from "../db.js"
import { metrics as metricsTable } from "../db/schema.js"
import { PostgresConnector } from "../connectors/postgres-connector.js"
import type { QueryActivitySample, TableInfo } from "../connectors/types.js"
import { getConnectionSecret } from "../secrets/store.js"

export interface IncidentContext {
  metricsAtDetection: { metricName: string; value: number }[]
  recentQueryActivity: QueryActivitySample[] | null
  schemaSummary: { name: string; approxRowCount: number; indexCount: number }[] | null
  liveContextError: string | null
}

// "Metrics at detection" = the exact collection-cycle batch at or before
// the incident's createdAt — every metrics row from one collection cycle
// shares the same `ts` (one INSERT statement, one now() call), so finding
// the latest ts <= createdAt and pulling that batch reconstructs the
// snapshot the anomaly detector actually saw.
async function metricsAtDetection(dbInstanceId: string, createdAt: Date) {
  const [latest] = await db
    .select({ ts: metricsTable.ts })
    .from(metricsTable)
    .where(and(eq(metricsTable.dbInstanceId, dbInstanceId), lte(metricsTable.ts, createdAt)))
    .orderBy(desc(metricsTable.ts))
    .limit(1)

  if (!latest) return []

  return db
    .select({ metricName: metricsTable.metricName, value: metricsTable.value })
    .from(metricsTable)
    .where(and(eq(metricsTable.dbInstanceId, dbInstanceId), eq(metricsTable.ts, latest.ts)))
}

function summarizeSchema(tables: TableInfo[]) {
  return tables
    .slice(0, 25)
    .map((t) => ({ name: `${t.schema}.${t.name}`, approxRowCount: t.approxRowCount, indexCount: t.indexes.length }))
}

// Live context (current query activity + schema) is best-effort: by the
// time the Root Cause Agent runs, the offending query may have finished, or
// the monitored DB may be temporarily unreachable. Both fail soft — the
// agent still runs on metrics history + runbooks alone, with the gap
// surfaced via `liveContextError` rather than failing the whole job.
export async function gatherIncidentContext(
  dbInstanceId: string,
  incidentCreatedAt: Date,
): Promise<IncidentContext> {
  const metricsSnapshot = await metricsAtDetection(dbInstanceId, incidentCreatedAt)

  const secret = await getConnectionSecret(dbInstanceId)
  if (!secret) {
    return {
      metricsAtDetection: metricsSnapshot,
      recentQueryActivity: null,
      schemaSummary: null,
      liveContextError: "No stored credentials for this database instance.",
    }
  }

  const connector = new PostgresConnector(secret)
  try {
    const [queryActivity, schema] = await Promise.all([
      connector.getRecentQueryActivity(),
      connector.listTablesAndIndexes(),
    ])

    return {
      metricsAtDetection: metricsSnapshot,
      recentQueryActivity: queryActivity,
      schemaSummary: summarizeSchema(schema.tables),
      liveContextError: null,
    }
  } catch (err) {
    return {
      metricsAtDetection: metricsSnapshot,
      recentQueryActivity: null,
      schemaSummary: null,
      liveContextError: err instanceof Error ? err.message : "Could not reach the monitored database.",
    }
  } finally {
    await connector.close()
  }
}
