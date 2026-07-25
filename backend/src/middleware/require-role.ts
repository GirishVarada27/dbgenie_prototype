import type { NextFunction, Request, Response } from "express"
import { isOrgRole, type OrgRole } from "@dbgenie/shared"
import { reqParam } from "../utils/params.js"

export type MemberLookup = (userId: string, orgId: string) => Promise<{ role: string } | null>

// Reads the organization plugin's own "member" table directly rather than
// going through auth.api at request time — one indexed query, and it keeps
// this middleware unit-testable via the `lookup` param without a real DB.
// db.js is imported lazily so unit tests that inject their own `lookup`
// never trigger its DATABASE_URL check.
const defaultLookup: MemberLookup = async (userId, orgId) => {
  const { pool } = await import("../db.js")
  const result = await pool.query<{ role: string }>(
    'SELECT role FROM "member" WHERE "userId" = $1 AND "organizationId" = $2 LIMIT 1',
    [userId, orgId],
  )
  return result.rows[0] ?? null
}

// Expects to run after requireAuth (req.user set) and on a route with an
// :orgId param. Never trust an org id from the request body — only the
// route path, so it can't be swapped independently of what was authorized.
export function requireRole(allowedRoles: OrgRole[], lookup: MemberLookup = defaultLookup) {
  return async function roleMiddleware(req: Request, res: Response, next: NextFunction) {
    if (!req.user) {
      res.status(401).json({ error: "You must be signed in." })
      return
    }

    const orgId = reqParam(req.params.orgId)
    if (!orgId) {
      res.status(400).json({ error: "Missing organization id in route." })
      return
    }

    const member = await lookup(req.user.id, orgId)

    if (!member || !isOrgRole(member.role) || !allowedRoles.includes(member.role)) {
      res.status(403).json({ error: "You do not have permission to perform this action." })
      return
    }

    next()
  }
}
