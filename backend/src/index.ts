import "./load-env.js"
import cors from "cors"
import express from "express"
import { toNodeHandler } from "better-auth/node"
import { auth } from "./auth.js"
import { initDb } from "./db/init.js"
import { logger } from "./logger.js"
import { httpLogger } from "./http-logger.js"
import { authLimiter, chatLimiter, generalLimiter } from "./middleware/rate-limit.js"
import healthRouter from "./routes/health.js"
import databaseInstancesRouter from "./routes/database-instances.js"
import incidentsRouter from "./routes/incidents.js"
import chatRouter from "./routes/chat.js"

const trustedOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:5176")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)

const app = express()

app.use(httpLogger)

app.use(
  cors({
    origin: trustedOrigins,
    credentials: true,
  }),
)

// Tighter limit on auth (brute-force/credential-stuffing surface), applied
// before Better Auth's own handler since that handler parses its own body.
app.all("/api/auth/*splat", authLimiter, toNodeHandler(auth))

app.use(express.json())

// Broad safety net on everything else under /api, with chat additionally
// tightened below (each request calls the Gemini API + RAG retrieval).
app.use("/api", generalLimiter)

app.use("/health", healthRouter)
app.use("/api/orgs/:orgId/database-instances", databaseInstancesRouter)
app.use("/api/orgs/:orgId/incidents", incidentsRouter)
app.use("/api/orgs/:orgId/chat", chatLimiter, chatRouter)

app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err, requestId: req.id }, "Unhandled request error")
  res.status(500).json({ error: "Internal server error" })
})

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001

initDb()
  .then(() => {
    app.listen(PORT, () => {
      logger.info(`Server listening on port ${PORT}`)
    })
  })
  .catch((err) => {
    logger.error({ err }, "Failed to initialize database")
    process.exit(1)
  })
