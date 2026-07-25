import { Router } from "express"
import { pool } from "../db.js"
import { logger } from "../logger.js"

const router = Router()

router.get("/", async (_req, res) => {
  try {
    await pool.query("SELECT 1")
    res.status(200).json({ status: "ok", db: "connected" })
  } catch (err) {
    logger.error({ err }, "Health check DB query failed")
    res.status(500).json({ status: "error", db: "unreachable" })
  }
})

export default router
