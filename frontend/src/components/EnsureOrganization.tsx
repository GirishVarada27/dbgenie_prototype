import { useEffect, useRef, useState, type ReactNode } from "react"
import { authClient, useSession } from "../lib/auth-client"

// Stage 1 wired up the organization plugin but never gave users a way to
// get one — there's no multi-org UI in this prototype, just a single
// auto-provisioned "workspace" per user, set active immediately so every
// org-scoped route (database instances, incidents, ...) has something to
// scope to. Runs once per session, below RequireAuth.
export default function EnsureOrganization({ children }: { children: ReactNode }) {
  const { data: session } = useSession()
  const { data: activeOrg, isPending: activePending } = authClient.useActiveOrganization()
  const { data: orgs, isPending: listPending } = authClient.useListOrganizations()
  const [error, setError] = useState<string | null>(null)
  const attempted = useRef(false)

  useEffect(() => {
    if (activePending || listPending || activeOrg || !orgs || !session?.user || attempted.current) return
    attempted.current = true

    async function ensureOrg() {
      if (orgs && orgs.length > 0) {
        await authClient.organization.setActive({ organizationId: orgs[0].id })
        return
      }

      const label = session?.user.name || session?.user.email || "My"
      const { data: created, error: createError } = await authClient.organization.create({
        name: `${label}'s Workspace`,
        slug: `org-${session!.user.id.slice(0, 10).toLowerCase()}-${Date.now().toString(36)}`,
      })

      if (createError || !created) {
        setError(createError?.message ?? "Could not set up your workspace.")
        return
      }

      await authClient.organization.setActive({ organizationId: created.id })
    }

    ensureOrg().catch((err) => {
      setError(err instanceof Error ? err.message : "Could not set up your workspace.")
    })
  }, [activePending, listPending, activeOrg, orgs, session])

  if (error) {
    return <p className="py-16 text-center text-sm text-red-600">{error}</p>
  }

  if (activePending || listPending || !activeOrg) {
    return <p className="py-16 text-center text-sm text-slate-500">Setting up your workspace...</p>
  }

  return children
}
