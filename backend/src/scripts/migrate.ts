import "../load-env.js"
import { initDb } from "../db/init.js"
import { pool } from "../db.js"

// Standalone equivalent of what the API/worker already do automatically on
// every boot — useful for CI (migrate a fresh test database before running
// integration tests) or anyone who wants to pre-warm a database without
// starting the full app.
initDb()
  .then(async () => {
    console.log("Migrations applied.")
    await pool.end()
  })
  .catch((err) => {
    console.error("Migration failed:", err)
    process.exit(1)
  })
