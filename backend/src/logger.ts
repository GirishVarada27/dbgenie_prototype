import pino from "pino"

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
})

// Child logger tagged with the job's own id plus whatever bindings the
// caller wants (e.g. a `correlationId`) so a worker job's log lines can be
// traced back to whatever triggered it — the HTTP request that enqueued it
// directly (e.g. a user clicking "run backup validation"), or the upstream
// job that enqueued it (e.g. the metrics-collection job that opened an
// incident and enqueued a root-cause-agent job in response).
export function jobLogger(jobName: string, jobId: string, bindings: Record<string, unknown> = {}) {
  return logger.child({ job: jobName, jobId, ...bindings })
}
