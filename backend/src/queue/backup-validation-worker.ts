import { Worker, type Job } from "bullmq"
import { eq } from "drizzle-orm"
import { db } from "../db.js"
import { backupValidations, databaseInstances } from "../db/schema.js"
import { PostgresConnector, type PostgresConnectionConfig } from "../connectors/postgres-connector.js"
import { getConnectionSecret } from "../secrets/store.js"
import * as neon from "../neon/client.js"
import { jobLogger } from "../logger.js"
import { redisConnection } from "./connection.js"
import {
  BACKUP_VALIDATION_QUEUE_NAME,
  RUN_BACKUP_VALIDATION_JOB,
  type RunBackupValidationJobData,
} from "./backup-validation-queue.js"

interface TableComparison {
  table: string
  expectedRows: number
  actualRows: number
  withinTolerance: boolean
}

interface ValidationDetails {
  connectivityOk: boolean
  connectivityMessage: string
  branchId: string | null
  tableComparisons: TableComparison[]
  error?: string
}

function connectionConfigFromUri(uri: string): PostgresConnectionConfig {
  const url = new URL(uri)
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database: url.pathname.replace(/^\//, ""),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    sslMode: url.searchParams.get("sslmode") ?? "require",
  }
}

// A table's live row count can drift between the snapshot and the branch
// being ready (real writes keep happening on the source), so exact equality
// isn't a meaningful pass/fail bar — flag it only if the drift is larger
// than what ordinary concurrent activity would plausibly explain.
function withinTolerance(expected: number, actual: number): boolean {
  const tolerance = Math.max(5, Math.ceil(expected * 0.05))
  return Math.abs(expected - actual) <= tolerance
}

async function finish(validationId: string, status: "passed" | "failed", details: ValidationDetails): Promise<void> {
  await db
    .update(backupValidations)
    .set({ status, details, neonBranchId: details.branchId, completedAt: new Date() })
    .where(eq(backupValidations.id, validationId))
}

async function processRunBackupValidationJob(job: Job<RunBackupValidationJobData>): Promise<void> {
  const { validationId, dbInstanceId, correlationId } = job.data
  const log = jobLogger(RUN_BACKUP_VALIDATION_JOB, job.id ?? "unknown", { validationId, correlationId })

  const [instance] = await db.select().from(databaseInstances).where(eq(databaseInstances.id, dbInstanceId))
  if (!instance) return // deleted before this ran

  if (!instance.neonProjectId) {
    await finish(validationId, "failed", {
      connectivityOk: false,
      connectivityMessage: "",
      branchId: null,
      tableComparisons: [],
      error: "This database instance has no Neon project ID configured.",
    })
    return
  }

  const secret = await getConnectionSecret(dbInstanceId)
  if (!secret) {
    await finish(validationId, "failed", {
      connectivityOk: false,
      connectivityMessage: "",
      branchId: null,
      tableComparisons: [],
      error: "No stored credentials for this database instance.",
    })
    return
  }

  // 1. Snapshot expected row counts from the live source before branching.
  const sourceConnector = new PostgresConnector(secret)
  let expectedCounts: Map<string, number>
  try {
    const schema = await sourceConnector.listTablesAndIndexes()
    expectedCounts = new Map(schema.tables.map((t) => [`${t.schema}.${t.name}`, t.approxRowCount]))
  } finally {
    await sourceConnector.close()
  }

  // 2. Create a temporary branch off the project's default branch.
  let branchId: string | null = null
  try {
    const defaultBranch = await neon.getDefaultBranch(instance.neonProjectId)
    const { branch, operations } = await neon.createBranch(
      instance.neonProjectId,
      defaultBranch.id,
      `dbgenie-validation-${validationId}`,
    )
    branchId = branch.id
    log.info({ branchId }, "Created temporary Neon branch, waiting for it to become ready")
    await neon.waitForOperations(instance.neonProjectId, operations)

    // 3. Connect to the branch and compare + smoke test.
    const databases = await neon.listDatabases(instance.neonProjectId, branch.id)
    const targetDb = databases.find((d) => d.name === secret.database) ?? databases[0]
    if (!targetDb) {
      throw new Error("The new branch has no databases to connect to.")
    }

    const uri = await neon.getConnectionUri(instance.neonProjectId, branch.id, targetDb.name, targetDb.owner_name)
    const branchConnector = new PostgresConnector(connectionConfigFromUri(uri))

    let details: ValidationDetails
    try {
      const connectivity = await branchConnector.testConnection()
      if (connectivity.ok) {
        // A brand-new branch has cold planner statistics even though its
        // data is a real copy — without this, every table reads as ~0
        // rows regardless of what was actually copied. See
        // connectors/types.ts's refreshStatistics() doc comment.
        log.info("Refreshing statistics on the new branch before comparing row counts")
        await branchConnector.refreshStatistics()
      }
      const branchSchema = connectivity.ok
        ? await branchConnector.listTablesAndIndexes()
        : { tables: [] }
      const actualCounts = new Map(branchSchema.tables.map((t) => [`${t.schema}.${t.name}`, t.approxRowCount]))

      const tableComparisons: TableComparison[] = [...expectedCounts.entries()].map(([table, expectedRows]) => {
        const actualRows = actualCounts.get(table) ?? 0
        return { table, expectedRows, actualRows, withinTolerance: withinTolerance(expectedRows, actualRows) }
      })

      details = {
        connectivityOk: connectivity.ok,
        connectivityMessage: connectivity.message,
        branchId,
        tableComparisons,
      }
    } finally {
      await branchConnector.close()
    }

    const passed = details.connectivityOk && details.tableComparisons.every((c) => c.withinTolerance)
    log.info({ passed, tableCount: details.tableComparisons.length }, "Backup validation complete")
    await finish(validationId, passed ? "passed" : "failed", details)
  } catch (err) {
    log.error({ err }, "Backup validation failed")
    await finish(validationId, "failed", {
      connectivityOk: false,
      connectivityMessage: "",
      branchId,
      tableComparisons: [],
      error: err instanceof Error ? err.message : "Backup validation failed.",
    })
  } finally {
    // Always tear down the temporary branch, pass or fail.
    if (branchId) {
      await neon.deleteBranch(instance.neonProjectId, branchId).catch((err) => {
        log.error({ err, branchId }, "Failed to delete temporary Neon branch")
      })
    }
  }
}

export function startBackupValidationWorker(): Worker<RunBackupValidationJobData> {
  const worker = new Worker<RunBackupValidationJobData>(
    BACKUP_VALIDATION_QUEUE_NAME,
    processRunBackupValidationJob,
    { connection: redisConnection, concurrency: 2 },
  )

  worker.on("failed", (job, err) => {
    jobLogger(RUN_BACKUP_VALIDATION_JOB, job?.id ?? "unknown", { correlationId: job?.data.correlationId }).error(
      { err },
      "Job failed",
    )
  })

  return worker
}
