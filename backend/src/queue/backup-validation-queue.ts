import { Queue } from "bullmq"
import { redisConnection } from "./connection.js"

export const BACKUP_VALIDATION_QUEUE_NAME = "backup-validation"
export const RUN_BACKUP_VALIDATION_JOB = "run-backup-validation"

export interface RunBackupValidationJobData {
  validationId: string
  dbInstanceId: string
  // The HTTP request id (see http-logger.ts) that triggered this run —
  // this job type, unlike metrics-collection or root-cause-agent, is
  // always directly triggered by a user clicking "Run backup validation".
  correlationId?: string
}

export const backupValidationQueue = new Queue<RunBackupValidationJobData>(BACKUP_VALIDATION_QUEUE_NAME, {
  connection: redisConnection,
})

// One-off job — the route that triggers a validation run already creates
// the `backup_validations` row (status='running') and passes its id along,
// so the worker only ever updates that one row rather than owning creation
// too. See routes/database-instances.ts.
export async function enqueueBackupValidation(
  validationId: string,
  dbInstanceId: string,
  correlationId?: string,
): Promise<void> {
  await backupValidationQueue.add(
    RUN_BACKUP_VALIDATION_JOB,
    { validationId, dbInstanceId, correlationId },
    {
      jobId: `backup-validation-${validationId}`,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 50 },
    },
  )
}
