import { Worker, type Job } from "bullmq"
import { eq } from "drizzle-orm"
import { db } from "../db.js"
import { incidents, recommendations } from "../db/schema.js"
import { retrieveRunbookChunks } from "../ai/retrieval.js"
import { gatherIncidentContext, type IncidentContext } from "../ai/root-cause-context.js"
import { diagnoseIncident } from "../ai/root-cause-agent.js"
import { jobLogger } from "../logger.js"
import { redisConnection } from "./connection.js"
import { ANALYZE_INCIDENT_JOB, ROOT_CAUSE_QUEUE_NAME, type AnalyzeIncidentJobData } from "./root-cause-queue.js"

const RETRIEVAL_METRIC_NAMES = [
  "active_connections",
  "max_connections",
  "longest_running_query_seconds",
  "pg_locks.count",
]

function buildRetrievalQuery(severity: string, context: IncidentContext): string {
  const metricsSummary = context.metricsAtDetection
    .filter((m) => RETRIEVAL_METRIC_NAMES.includes(m.metricName))
    .map((m) => `${m.metricName}=${m.value}`)
    .join(", ")

  return `PostgreSQL database incident, severity ${severity}. Metrics: ${metricsSummary}.`
}

async function processAnalyzeIncidentJob(job: Job<AnalyzeIncidentJobData>): Promise<void> {
  const { incidentId, correlationId } = job.data
  const log = jobLogger(ANALYZE_INCIDENT_JOB, job.id ?? "unknown", { incidentId, correlationId })

  const [incident] = await db.select().from(incidents).where(eq(incidents.id, incidentId))
  if (!incident) {
    // Deleted (e.g. its database instance was removed) before this ran.
    return
  }

  log.info("Starting root cause analysis")
  const context = await gatherIncidentContext(incident.dbInstanceId, incident.createdAt)
  const chunks = await retrieveRunbookChunks(buildRetrievalQuery(incident.severity, context), 5)
  const diagnosis = await diagnoseIncident(incident.severity, context, chunks)
  log.info({ confidenceScore: diagnosis.confidenceScore, requiresHumanReview: diagnosis.requiresHumanReview }, "Root cause analysis complete")

  await db
    .update(incidents)
    .set({
      rootCause: diagnosis.rootCause,
      confidenceScore: diagnosis.confidenceScore,
      requiresHumanReview: diagnosis.requiresHumanReview,
    })
    .where(eq(incidents.id, incidentId))

  if (diagnosis.recommendedActions.length > 0) {
    await db.insert(recommendations).values(
      diagnosis.recommendedActions.map((actionText) => ({
        incidentId,
        agentSource: "root-cause-agent",
        actionText,
        confidenceScore: diagnosis.confidenceScore,
        sources: diagnosis.citedSources,
      })),
    )
  }
}

export function startRootCauseWorker(): Worker<AnalyzeIncidentJobData> {
  const worker = new Worker<AnalyzeIncidentJobData>(ROOT_CAUSE_QUEUE_NAME, processAnalyzeIncidentJob, {
    connection: redisConnection,
    concurrency: 3,
  })

  worker.on("failed", (job, err) => {
    jobLogger(ANALYZE_INCIDENT_JOB, job?.id ?? "unknown", { correlationId: job?.data.correlationId }).error(
      { err },
      "Job failed",
    )
  })

  return worker
}
