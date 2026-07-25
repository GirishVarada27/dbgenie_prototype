import { Router } from "express"
import { and, desc, eq } from "drizzle-orm"
import { ORG_ROLES } from "@dbgenie/shared"
import { db } from "../db.js"
import { databaseInstances, incidents, recommendations } from "../db/schema.js"
import { requireAuth } from "../middleware/require-auth.js"
import { requireRole } from "../middleware/require-role.js"
import { reqParam } from "../utils/params.js"

const router = Router({ mergeParams: true })
router.use(requireAuth)

// Incidents don't carry org_id directly (only db_instance_id) — org scoping
// goes through database_instances, same as metrics.
router.get("/", requireRole([...ORG_ROLES]), async (req, res) => {
  const orgId = reqParam(req.params.orgId)
  const statusFilter = typeof req.query.status === "string" ? req.query.status : undefined
  const dbInstanceIdFilter = typeof req.query.dbInstanceId === "string" ? req.query.dbInstanceId : undefined

  const conditions = [eq(databaseInstances.orgId, orgId)]
  if (statusFilter) conditions.push(eq(incidents.status, statusFilter))
  if (dbInstanceIdFilter) conditions.push(eq(incidents.dbInstanceId, dbInstanceIdFilter))

  const rows = await db
    .select({
      id: incidents.id,
      dbInstanceId: incidents.dbInstanceId,
      severity: incidents.severity,
      rootCause: incidents.rootCause,
      confidenceScore: incidents.confidenceScore,
      requiresHumanReview: incidents.requiresHumanReview,
      status: incidents.status,
      createdAt: incidents.createdAt,
      databaseName: databaseInstances.name,
    })
    .from(incidents)
    .innerJoin(databaseInstances, eq(incidents.dbInstanceId, databaseInstances.id))
    .where(and(...conditions))
    .orderBy(desc(incidents.createdAt))

  res.json(rows)
})

// Scoped through database_instances the same way as the list route above —
// an incident id alone doesn't carry org_id, so this confirms the incident
// actually belongs to an instance in this org before returning anything.
router.get("/:id/recommendations", requireRole([...ORG_ROLES]), async (req, res) => {
  const orgId = reqParam(req.params.orgId)
  const incidentId = reqParam(req.params.id)

  const [incident] = await db
    .select({ id: incidents.id })
    .from(incidents)
    .innerJoin(databaseInstances, eq(incidents.dbInstanceId, databaseInstances.id))
    .where(and(eq(incidents.id, incidentId), eq(databaseInstances.orgId, orgId)))

  if (!incident) {
    res.status(404).json({ error: "Incident not found." })
    return
  }

  const rows = await db
    .select()
    .from(recommendations)
    .where(eq(recommendations.incidentId, incidentId))
    .orderBy(desc(recommendations.createdAt))

  res.json(rows)
})

export default router
