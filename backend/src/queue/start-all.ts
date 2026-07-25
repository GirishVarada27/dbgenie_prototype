import { eq } from "drizzle-orm"
import { db } from "../db.js"
import { databaseInstances } from "../db/schema.js"
import { logger } from "../logger.js"
import { startMetricsWorker } from "./metrics-worker.js"
import { scheduleMetricsCollection } from "./metrics-queue.js"
import { startRootCauseWorker } from "./root-cause-worker.js"
import { startBackupValidationWorker } from "./backup-validation-worker.js"

async function syncRepeatableJobs(): Promise<void> {
  // Re-registers the 30s metrics-collection job for every currently-active
  // database instance. BullMQ's repeatable-job add is idempotent (same
  // pattern + jobId doesn't duplicate), so this is safe to run on every
  // worker boot — it's a safety net in case Redis lost its scheduler state
  // (e.g. a fresh Upstash/Render Redis) rather than the primary mechanism,
  // which is scheduling a job at database-instance creation time.
  const active = await db
    .select({ id: databaseInstances.id })
    .from(databaseInstances)
    .where(eq(databaseInstances.status, "active"))

  await Promise.all(active.map((instance) => scheduleMetricsCollection(instance.id)))

  if (active.length > 0) {
    logger.info(`Synced metrics-collection jobs for ${active.length} active database instance(s).`)
  }
}

// Starts the BullMQ workers that process metrics-collection, root-cause-agent,
// and backup-validation jobs. Called from worker.ts for the standalone `npm
// run start:worker` process, and also from index.ts when
// RUN_WORKER_IN_PROCESS=true — used when the deployment target has no
// separate background-worker tier (e.g. Render's free plan) and the API and
// worker have to share a single process.
export async function startAllWorkers(): Promise<void> {
  await syncRepeatableJobs()
  startMetricsWorker()
  startRootCauseWorker()
  startBackupValidationWorker()
  logger.info(
    "DBGenie worker started — processing metrics-collection, root-cause-agent, and backup-validation jobs.",
  )
}
