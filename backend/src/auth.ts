import { betterAuth } from "better-auth"
import { organization, twoFactor } from "better-auth/plugins"
import { pool } from "./db.js"

const trustedOrigins = (process.env.CORS_ORIGINS ?? "http://localhost:5176")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)

// The API and frontend can be deployed as separate origins (e.g.
// dbgenie-api.onrender.com / dbgenie-frontend.onrender.com — different
// sites, since onrender.com is a public suffix, not a shared parent domain
// crossSubDomainCookies could target). Better Auth's default SameSite=Lax
// cookie is dropped by browsers on cross-site fetch/XHR, so every
// authenticated request after sign-in would silently look like a fresh,
// logged-out session. SameSite=None needs Secure, which browsers refuse to
// set over plain HTTP — only turn this on when BETTER_AUTH_URL is actually
// HTTPS, so local dev (http://localhost) keeps the default Lax cookie.
const isHttpsDeployment = (process.env.BETTER_AUTH_URL ?? "").startsWith("https://")

export const auth = betterAuth({
  database: pool,
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  trustedOrigins,
  advanced: isHttpsDeployment
    ? { defaultCookieAttributes: { sameSite: "none", secure: true } }
    : undefined,
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
