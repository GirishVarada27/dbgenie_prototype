import { Router } from "express"
import { and, desc, eq } from "drizzle-orm"
import { ORG_ROLES, type CreateDatabaseInstanceInput } from "@dbgenie/shared"
import { db } from "../db.js"
import { backupValidations, databaseInstances, metrics } from "../db/schema.js"
import { requireAuth } from "../middleware/require-auth.js"
import { requireRole } from "../middleware/require-role.js"
import { reqParam } from "../utils/params.js"
import { PostgresConnector } from "../connectors/postgres-connector.js"
import { getConnectionSecret, storeConnectionSecret } from "../secrets/store.js"
import { scheduleMetricsCollection, unscheduleMetricsCollection } from "../queue/metrics-queue.js"
import { enqueueBackupValidation } from "../queue/backup-validation-queue.js"
import { analyzeSql } from "../ai/sql-optimizer.js"
import { recordAuditLog } from "../middleware/audit-log.js"

const router = Router({ mergeParams: true })
router.use(requireAuth)

const WRITE_ROLES = ["owner", "admin"] as const
const READ_ROLES = [...ORG_ROLES]

// Shared by every /:id sub-route — confirms the instance exists AND belongs
// to the org in the URL before anything else touches it.
async function loadOrgScopedInstance(orgId: string, id: string) {
  const [instance] = await db
    .select()
    .from(databaseInstances)
    .where(and(eq(databaseInstances.id, id), eq(databaseInstances.orgId, orgId)))
  return instance ?? null
}

function parseCreateInput(body: unknown): { data: CreateDatabaseInstanceInput } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "Request body must be an object." }
  const b = body as Record<string, unknown>

  if (typeof b.name !== "string" || !b.name.trim()) return { error: "name is required." }
  if (typeof b.host !== "string" || !b.host.trim()) return { error: "host is required." }
  if (typeof b.port !== "number" || !Number.isInteger(b.port) || b.port <= 0) {
    return { error: "port must be a positive integer." }
  }
  if (typeof b.database !== "string" || !b.database.trim()) return { error: "database is required." }
  if (typeof b.user !== "string" || !b.user.trim()) return { error: "user is required." }
  if (typeof b.password !== "string" || !b.password) return { error: "password is required." }
  if (typeof b.sslMode !== "string" || !b.sslMode.trim()) return { error: "sslMode is required." }
  if (b.neonProjectId !== undefined && typeof b.neonProjectId !== "string") {
    return { error: "neonProjectId must be a string." }
  }

  return {
    data: {
      name: b.name,
      host: b.host,
      port: b.port,
      database: b.database,
      user: b.user,
      password: b.password,
      sslMode: b.sslMode,
      neonProjectId: b.neonProjectId?.trim() || undefined,
    },
  }
}

router.get("/", requireRole(READ_ROLES), async (req, res) => {
  const orgId = reqParam(req.params.orgId)
  const rows = await db
    .select({
      id: databaseInstances.id,
      orgId: databaseInstances.orgId,
      name: databaseInstances.name,
      engine: databaseInstances.engine,
      sslMode: databaseInstances.sslMode,
      status: databaseInstances.status,
      neonProjectId: databaseInstances.neonProjectId,
      createdAt: databaseInstances.createdAt,
    })
    .from(databaseInstances)
    .where(eq(databaseInstances.orgId, orgId))
    .orderBy(desc(databaseInstances.createdAt))

  res.json(rows)
})

router.post("/", requireRole([...WRITE_ROLES]), async (req, res) => {
  const orgId = reqParam(req.params.orgId)
  const parsed = parseCreateInput(req.body)
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error })
    return
  }
  const input = parsed.data

  const connector = new PostgresConnector(input)
  const testResult = await connector.testConnection()
  await connector.close()

  if (!testResult.ok) {
    res.status(422).json({ error: `Could not connect: ${testResult.message}` })
    return
  }

  const [instance] = await db
    .insert(databaseInstances)
    .values({
      orgId,
      name: input.name,
      engine: "postgres",
      sslMode: input.sslMode,
      status: "active",
      neonProjectId: input.neonProjectId ?? null,
    })
    .returning()

  await storeConnectionSecret(instance.id, {
    host: input.host,
    port: input.port,
    database: input.database,
    user: input.user,
    password: input.password,
    sslMode: input.sslMode,
  })

  await scheduleMetricsCollection(instance.id)

  await recordAuditLog(req, {
    action: "database_instance.create",
    targetEntity: `database_instances:${instance.id}`,
    afterState: instance,
  })

  res.status(201).json(instance)
})

router.get("/:id", requireRole(READ_ROLES), async (req, res) => {
  const instance = await loadOrgScopedInstance(reqParam(req.params.orgId), reqParam(req.params.id))
  if (!instance) {
    res.status(404).json({ error: "Database instance not found." })
    return
  }

  res.json(instance)
})

router.get("/:id/metrics", requireRole(READ_ROLES), async (req, res) => {
  const instance = await loadOrgScopedInstance(reqParam(req.params.orgId), reqParam(req.params.id))
  if (!instance) {
    res.status(404).json({ error: "Database instance not found." })
    return
  }

  const limit = Math.min(Number(req.query.limit) || 300, 1000)
  const rows = await db
    .select()
    .from(metrics)
    .where(eq(metrics.dbInstanceId, instance.id))
    .orderBy(desc(metrics.ts))
    .limit(limit)

  res.json(rows.reverse())
})

router.post("/:id/test-connection", requireRole([...WRITE_ROLES]), async (req, res) => {
  const instance = await loadOrgScopedInstance(reqParam(req.params.orgId), reqParam(req.params.id))
  if (!instance) {
    res.status(404).json({ error: "Database instance not found." })
    return
  }

  const secret = await getConnectionSecret(instance.id)
  if (!secret) {
    res.status(500).json({ error: "No stored credentials for this database instance." })
    return
  }

  const connector = new PostgresConnector(secret)
  const result = await connector.testConnection()
  await connector.close()

  const newStatus = result.ok ? "active" : "unreachable"
  await db.update(databaseInstances).set({ status: newStatus }).where(eq(databaseInstances.id, instance.id))

  res.json({ ...result, status: newStatus })
})

router.delete("/:id", requireRole([...WRITE_ROLES]), async (req, res) => {
  const instance = await loadOrgScopedInstance(reqParam(req.params.orgId), reqParam(req.params.id))
  if (!instance) {
    res.status(404).json({ error: "Database instance not found." })
    return
  }

  // BullMQ's schedule isn't in Postgres, so it needs an explicit unschedule.
  // secrets/metrics/incidents/recommendations all cascade-delete via FK.
  await unscheduleMetricsCollection(instance.id)
  await db.delete(databaseInstances).where(eq(databaseInstances.id, instance.id))

  await recordAuditLog(req, {
    action: "database_instance.delete",
    targetEntity: `database_instances:${instance.id}`,
    beforeState: instance,
  })

  res.status(204).send()
})

// Read-only by construction the whole way down: getExplainPlan() runs bare
// EXPLAIN (never ANALYZE, which would actually execute the query — see
// PostgresConnector), and the model is only ever asked for a text/DDL
// suggestion, never invoked to run anything itself.
router.post("/:id/sql/analyze", requireRole(READ_ROLES), async (req, res) => {
  const instance = await loadOrgScopedInstance(reqParam(req.params.orgId), reqParam(req.params.id))
  if (!instance) {
    res.status(404).json({ error: "Database instance not found." })
    return
  }

  const sql = typeof req.body?.sql === "string" ? req.body.sql.trim() : ""
  if (!sql) {
    res.status(400).json({ error: "sql is required." })
    return
  }

  const secret = await getConnectionSecret(instance.id)
  if (!secret) {
    res.status(500).json({ error: "No stored credentials for this database instance." })
    return
  }

  const connector = new PostgresConnector(secret)
  try {
    const [plan, schema] = await Promise.all([connector.getExplainPlan(sql), connector.listTablesAndIndexes()])
    const suggestion = await analyzeSql(sql, plan, schema)
    res.json({ plan: plan.plan, ...suggestion })
  } catch (err) {
    res.status(422).json({ error: err instanceof Error ? err.message : "Could not analyze this query." })
  } finally {
    await connector.close()
  }
})

router.get("/:id/backup-validations", requireRole(READ_ROLES), async (req, res) => {
  const instance = await loadOrgScopedInstance(reqParam(req.params.orgId), reqParam(req.params.id))
  if (!instance) {
    res.status(404).json({ error: "Database instance not found." })
    return
  }

  const rows = await db
    .select()
    .from(backupValidations)
    .where(eq(backupValidations.dbInstanceId, instance.id))
    .orderBy(desc(backupValidations.createdAt))
    .limit(20)

  res.json(rows)
})

// Only meaningful for Neon-hosted instances (neonProjectId set at
// onboarding) — creates/tears down a real temporary branch, so this is a
// write-role action even though it doesn't touch the monitored database's
// own data.
router.post("/:id/backup-validations", requireRole([...WRITE_ROLES]), async (req, res) => {
  const instance = await loadOrgScopedInstance(reqParam(req.params.orgId), reqParam(req.params.id))
  if (!instance) {
    res.status(404).json({ error: "Database instance not found." })
    return
  }

  if (!instance.neonProjectId) {
    res.status(422).json({ error: "This database instance has no Neon project ID configured." })
    return
  }

  const [validation] = await db
    .insert(backupValidations)
    .values({ dbInstanceId: instance.id, status: "running" })
    .returning()

  await enqueueBackupValidation(validation.id, instance.id, String(req.id))

  await recordAuditLog(req, {
    action: "backup_validation.trigger",
    targetEntity: `backup_validations:${validation.id}`,
    afterState: validation,
  })

  res.status(202).json(validation)
})

export default router
