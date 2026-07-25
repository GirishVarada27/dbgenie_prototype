import type { Request } from "express"
import { getAuditPool } from "../db/audit-pool.js"
import { logger } from "../logger.js"
import { reqParam } from "../utils/params.js"

export interface AuditEntry {
  action: string
  targetEntity: string
  beforeState?: unknown
  afterState?: unknown
}

// Called explicitly from mutating route handlers (create/delete database
// instances, trigger backup validation, ...) rather than as a blind
// generic interceptor — only the route itself actually knows what a
// meaningful "before"/"after" state is for the resource it's mutating.
// Failing to write an audit row must never fail the mutation it describes.
export async function recordAuditLog(req: Request, entry: AuditEntry): Promise<void> {
  try {
    const pool = getAuditPool()
    await pool.query(
      `INSERT INTO audit_logs (user_id, org_id, action, target_entity, before_state, after_state, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        req.user?.id ?? null,
        reqParam(req.params.orgId) || null,
        entry.action,
        entry.targetEntity,
        entry.beforeState === undefined ? null : JSON.stringify(entry.beforeState),
        entry.afterState === undefined ? null : JSON.stringify(entry.afterState),
        req.ip ?? null,
      ],
    )
  } catch (err) {
    logger.error({ err, action: entry.action, targetEntity: entry.targetEntity }, "Failed to write audit log")
  }
}
