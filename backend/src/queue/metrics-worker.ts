import { Worker, type Job } from "bullmq"
import { and, eq } from "drizzle-orm"
import { db } from "../db.js"
import { databaseInstances, incidents, metrics } from "../db/schema.js"
import { PostgresConnector } from "../connectors/postgres-connector.js"
import { getConnectionSecret } from "../secrets/store.js"
import { detectAnomalies, worstSeverity } from "../services/anomaly-detection.js"
import { jobLogger } from "../logger.js"
import { redisConnection } from "./connection.js"
import { COLLECT_METRICS_JOB, METRICS_QUEUE_NAME, type CollectMetricsJobData } from "./metrics-queue.js"
import { enqueueRootCauseAnalysis } from "./root-cause-queue.js"

async function processCollectMetricsJob(job: Job<CollectMetricsJobData>): Promise<void> {
  const { dbInstanceId } = job.data
  const log = jobLogger(COLLECT_METRICS_JOB, job.id ?? "unknown", { dbInstanceId })

  const [instance] = await db.select().from(databaseInstances).where(eq(databaseInstances.id, dbInstanceId))
  if (!instance) {
    // The database instance was deleted after this repeatable job was
    // scheduled but before this tick ran. Nothing to do — the caller is
    // responsible for unscheduling on delete, this is just a safety net.
    return
  }

  const secret = await getConnectionSecret(dbInstanceId)
  if (!secret) {
    log.error("No stored credentials for database instance, skipping collection")
    return
  }

  const connector = new PostgresConnector(secret)
  let samples: Awaited<ReturnType<typeof connector.collectMetrics>>

  try {
    samples = await connector.collectMetrics()
  } catch (err) {
    log.error({ err }, "Metrics collection failed")
    await db.update(databaseInstances).set({ status: "unreachable" }).where(eq(databaseInstances.id, dbInstanceId))
    await connector.close()
    return
  }
  await connector.close()

  if (samples.length > 0) {
    await db.insert(metrics).values(samples.map((s) => ({ dbInstanceId, metricName: s.metricName, value: s.value })))
  }

  if (instance.status !== "active") {
    await db.update(databaseInstances).set({ status: "active" }).where(eq(databaseInstances.id, dbInstanceId))
  }

  // Anomaly detection / incident creation / job enqueueing are deliberately
  // outside the try/catch above: a failure here (e.g. a queue error) is not
  // evidence the monitored database is unreachable, and must not mark the
  // instance 'unreachable' the way a real connection failure does.
  const findings = detectAnomalies(samples)
  if (findings.length > 0) {
    const [existingOpenIncident] = await db
      .select({ id: incidents.id })
      .from(incidents)
      .where(and(eq(incidents.dbInstanceId, dbInstanceId), eq(incidents.status, "open")))
      .limit(1)

    // One open incident per instance at a time in this prototype — avoids
    // creating a new row every 30s while the same condition persists.
    // Stage 3's Root Cause Agent is what eventually resolves/annotates it.
    if (!existingOpenIncident) {
      const [created] = await db
        .insert(incidents)
        .values({
          dbInstanceId,
          severity: worstSeverity(findings),
          status: "open",
        })
        .returning({ id: incidents.id })

      // Stage 3: every newly-opened incident gets a Root Cause Agent run.
      // Propagates this metrics job's own id as the root-cause job's
      // correlation id — traces the diagnosis back to the collection cycle
      // that detected the anomaly.
      await enqueueRootCauseAnalysis(created.id, job.id)
    }
  }
}

export function startMetricsWorker(): Worker<CollectMetricsJobData> {
  const worker = new Worker<CollectMetricsJobData>(METRICS_QUEUE_NAME, processCollectMetricsJob, {
    connection: redisConnection,
    concurrency: 5,
  })

  worker.on("failed", (job, err) => {
    jobLogger(COLLECT_METRICS_JOB, job?.id ?? "unknown").error({ err }, "Job failed")
  })

  return worker
}
