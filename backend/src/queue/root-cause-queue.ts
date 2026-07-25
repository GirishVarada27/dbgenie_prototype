import { Queue } from "bullmq"
import { redisConnection } from "./connection.js"

export const ROOT_CAUSE_QUEUE_NAME = "root-cause-agent"
export const ANALYZE_INCIDENT_JOB = "analyze-incident"

export interface AnalyzeIncidentJobData {
  incidentId: string
  // The triggering metrics-collection job's own BullMQ job id — not an
  // HTTP request id, since this job is only ever triggered by anomaly
  // detection inside a background job, never directly by a user request.
  // Lets a root-cause job's logs be traced back to the collection cycle
  // that opened the incident.
  correlationId?: string
}

export const rootCauseQueue = new Queue<AnalyzeIncidentJobData>(ROOT_CAUSE_QUEUE_NAME, {
  connection: redisConnection,
})

// One-off job, not repeatable — triggered each time the metrics worker's
// anomaly detection opens a new incident (see queue/metrics-worker.ts).
// jobId uses "-" not ":" — BullMQ rejects custom (non-repeatable) job IDs
// containing a colon (repeatable job ids don't hit this check, which is
// why metrics-queue.ts's "metrics:<id>" ids are fine).
export async function enqueueRootCauseAnalysis(incidentId: string, correlationId?: string): Promise<void> {
  await rootCauseQueue.add(
    ANALYZE_INCIDENT_JOB,
    { incidentId, correlationId },
    {
      jobId: `root-cause-${incidentId}`,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 50 },
    },
  )
}
