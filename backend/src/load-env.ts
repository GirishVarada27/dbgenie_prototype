import path from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"

// Loads the repo-root .env regardless of process.cwd() — npm workspace
// scripts run with cwd set to backend/, so the bare `dotenv/config` import
// (which only checks process.cwd()) would silently miss it.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.join(__dirname, "..", "..", ".env") })
