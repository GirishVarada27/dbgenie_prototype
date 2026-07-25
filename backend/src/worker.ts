import "./load-env.js"
import { initDb } from "./db/init.js"
import { logger } from "./logger.js"
import { startAllWorkers } from "./queue/start-all.js"

initDb()
  .then(startAllWorkers)
  .catch((err) => {
    logger.error({ err }, "Failed to start worker")
    process.exit(1)
  })
