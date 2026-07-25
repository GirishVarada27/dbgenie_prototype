import { createAuthClient } from "better-auth/react"
import { organizationClient, twoFactorClient } from "better-auth/client/plugins"

export const authClient = createAuthClient({
  // Unset in dev: Vite proxies /api to the backend, so same-origin is correct
  // (see vite.config.ts). Set in prod, where the frontend static site and
  // API web service are separate origins (see render.yaml).
  baseURL: import.meta.env.VITE_API_BASE_URL || undefined,
  plugins: [organizationClient(), twoFactorClient()],
})

export const { useSession, signIn, signUp, signOut } = authClient
