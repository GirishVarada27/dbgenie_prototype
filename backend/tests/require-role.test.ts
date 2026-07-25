import { describe, expect, it, vi } from "vitest"
import type { Request, Response } from "express"
import { requireRole } from "../src/middleware/require-role.js"

function mockRes() {
  const res: Partial<Response> = {}
  res.status = vi.fn().mockReturnValue(res)
  res.json = vi.fn().mockReturnValue(res)
  return res as Response
}

describe("requireRole", () => {
  it("401s when req.user is missing", async () => {
    const middleware = requireRole(["owner"], vi.fn())
    const req = { params: { orgId: "org1" } } as unknown as Request
    const res = mockRes()
    const next = vi.fn()

    await middleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(next).not.toHaveBeenCalled()
  })

  it("400s when the route has no :orgId param", async () => {
    const middleware = requireRole(["owner"], vi.fn())
    const req = { params: {}, user: { id: "u1" } } as unknown as Request
    const res = mockRes()
    const next = vi.fn()

    await middleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(400)
    expect(next).not.toHaveBeenCalled()
  })

  it("403s when the member's role is not in the allowed list", async () => {
    const lookup = vi.fn().mockResolvedValue({ role: "member" })
    const middleware = requireRole(["owner", "admin"], lookup)
    const req = { params: { orgId: "org1" }, user: { id: "u1" } } as unknown as Request
    const res = mockRes()
    const next = vi.fn()

    await middleware(req, res, next)

    expect(lookup).toHaveBeenCalledWith("u1", "org1")
    expect(res.status).toHaveBeenCalledWith(403)
    expect(next).not.toHaveBeenCalled()
  })

  it("403s when the user is not a member of the organization", async () => {
    const lookup = vi.fn().mockResolvedValue(null)
    const middleware = requireRole(["member"], lookup)
    const req = { params: { orgId: "org1" }, user: { id: "u1" } } as unknown as Request
    const res = mockRes()
    const next = vi.fn()

    await middleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(403)
  })

  it("calls next without touching res when the role is allowed", async () => {
    const lookup = vi.fn().mockResolvedValue({ role: "admin" })
    const middleware = requireRole(["owner", "admin"], lookup)
    const req = { params: { orgId: "org1" }, user: { id: "u1" } } as unknown as Request
    const res = mockRes()
    const next = vi.fn()

    await middleware(req, res, next)

    expect(next).toHaveBeenCalledOnce()
    expect(res.status).not.toHaveBeenCalled()
  })
})
