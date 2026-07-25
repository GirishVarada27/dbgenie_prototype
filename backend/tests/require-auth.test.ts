import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Request, Response } from "express"

const getSession = vi.fn()

vi.mock("../src/auth.js", () => ({
  auth: { api: { getSession } },
}))

const { requireAuth } = await import("../src/middleware/require-auth.js")

function mockRes() {
  const res: Partial<Response> = {}
  res.status = vi.fn().mockReturnValue(res)
  res.json = vi.fn().mockReturnValue(res)
  return res as Response
}

describe("requireAuth", () => {
  beforeEach(() => {
    getSession.mockReset()
  })

  it("returns 401 and does not call next when there is no session", async () => {
    getSession.mockResolvedValue(null)
    const req = { headers: {} } as Request
    const res = mockRes()
    const next = vi.fn()

    await requireAuth(req, res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ error: "You must be signed in." })
    expect(next).not.toHaveBeenCalled()
  })

  it("attaches user/session to req and calls next when authenticated", async () => {
    const session = { user: { id: "u1", email: "a@b.com" }, session: { id: "s1" } }
    getSession.mockResolvedValue(session)
    const req = { headers: {} } as Request
    const res = mockRes()
    const next = vi.fn()

    await requireAuth(req, res, next)

    expect(req.user).toEqual(session.user)
    expect(req.session).toEqual(session.session)
    expect(next).toHaveBeenCalledOnce()
    expect(res.status).not.toHaveBeenCalled()
  })
})
