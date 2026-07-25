import { betterAuth } from "better-auth"
import { organization, twoFactor } from "better-auth/plugins"
import { pool } from "./db.js"

const trustedOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:5176")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)

export const auth = betterAuth({
  database: pool,
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  trustedOrigins,
  emailAndPassword: {
    enabled: true,
  },
  plugins: [
    // Default roles are 'owner' | 'admin' | 'member', scoped per-organization
    // — this is exactly the RBAC shape Stage 1 asks for, so no custom
    // access-control config is defined here.
    organization(),
    twoFactor({
      issuer: "DBGenie AI",
    }),
  ],
})
