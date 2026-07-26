import { useNavigate } from "react-router-dom"
import { authClient, signOut, useSession } from "../lib/auth-client"
import PulseWaveform from "./PulseWaveform"

export default function Topbar() {
  const { data: session } = useSession()
  const { data: activeOrg } = authClient.useActiveOrganization()
  const navigate = useNavigate()

  async function handleSignOut() {
    await signOut()
    navigate("/login", { replace: true })
  }

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-background px-6">
      <span className="text-sm font-medium text-text-primary">{activeOrg?.name ?? ""}</span>

      <div className="flex items-center gap-6">
        <PulseWaveform />

        {session?.user && (
          <div className="flex items-center gap-4 text-sm">
            <span className="text-text-secondary">{session.user.email}</span>
            {!session.user.twoFactorEnabled && (
              <a href="/mfa/enroll" className="font-medium text-accent hover:underline">
                Enable MFA
              </a>
            )}
            <button
              type="button"
              onClick={handleSignOut}
              className="rounded-md border border-border px-3 py-1.5 text-text-secondary transition-colors hover:border-accent-dim hover:text-text-primary"
            >
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  )
}
