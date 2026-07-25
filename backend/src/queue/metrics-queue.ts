import { Queue } from "bullmq"
import { redisConnection } from "./connection.js"

export const METRICS_QUEUE_NAME = "metrics-collection"
export const COLLECT_METRICS_JOB = "collect-metrics"
export const REPEAT_EVERY_MS = 30_000

export interface CollectMetricsJobData {
  dbInstanceId: string
}

export const metricsQueue = new Queue<CollectMetricsJobData>(METRICS_QUEUE_NAME, {
  connection: redisConnection,
})

function repeatableJobId(dbInstanceId: string): string {
  return `metrics:${dbInstanceId}`
}

// Registers (or re-registers, idempotently — BullMQ dedupes on the repeat
// pattern + jobId) a 30s recurring metrics-collection job for this
// database instance. Called when a database is added, and again on worker
// boot for every 'active' instance as a safety net in case the queue's
// repeatable-job state didn't survive a Redis restart.
export async function scheduleMetricsCollection(dbInstanceId: string): Promise<void> {
  await metricsQueue.add(
    COLLECT_METRICS_JOB,
    { dbInstanceId },
    {
      jobId: repeatableJobId(dbInstanceId),
      // immediately: true fires the first collection right away instead of
      // waiting a full 30s — matters for "metrics populate within 60s of
      // onboarding" rather than leaving it to land near that boundary.
      repeat: { every: REPEAT_EVERY_MS, immediately: true },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 50 },
    },
  )
}

export async function unscheduleMetricsCollection(dbInstanceId: string): Promise<void> {
  // Repeat options must match what was passed to `add` for BullMQ to find
  // and remove the right repeatable job.
  await metricsQueue.removeRepeatable(
    COLLECT_METRICS_JOB,
    { every: REPEAT_EVERY_MS, immediately: true },
    repeatableJobId(dbInstanceId),
  )
}
