import { randomUUID } from "node:crypto"
import { pinoHttp } from "pino-http"
import { logger } from "./logger.js"

// Generates (or reuses an inbound x-request-id) a request id, logs it back
// on the response header, and attaches it to req.id — used both for
// structured request logs and as the correlation id propagated into BullMQ
// job data for the routes that enqueue jobs directly (see
// routes/database-instances.ts).
export const httpLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const inbound = req.headers["x-request-id"]
    const id = typeof inbound === "string" && inbound ? inbound : randomUUID()
    res.setHeader("x-request-id", id)
    return id
  },
})
