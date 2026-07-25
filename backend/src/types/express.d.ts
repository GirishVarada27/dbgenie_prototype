import type { auth } from "../auth.js"

type Session = typeof auth.$Infer.Session

declare global {
  namespace Express {
    interface Request {
      user?: Session["user"]
      session?: Session["session"]
    }
  }
}

export {}
