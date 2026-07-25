import path from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "dotenv"
import { defineConfig } from "drizzle-kit"

// Loads the repo-root .env regardless of cwd — see src/load-env.ts.
const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.join(__dirname, "..", ".env") })

// `drizzle-kit generate` only reads the schema file and doesn't connect, so
// dbCredentials is allowed to be a placeholder here. `migrate`/`push`/
// `studio` do connect and need a real DATABASE_URL in .env.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://placeholder/placeholder",
  },
})
