import { useNavigate } from "react-router-dom"
import { signOut, useSession } from "../lib/auth-client"

export default function Topbar() {
  const { data: session } = useSession()
  const navigate = useNavigate()

  async function handleSignOut() {
    await signOut()
    navigate("/login", { replace: true })
  }

  return (
    <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-6">
      <div />
      <div className="flex items-center gap-4 text-sm">
        {session?.user && (
          <>
            <span className="text-slate-600">{session.user.email}</span>
            {!session.user.twoFactorEnabled && (
              <a href="/mfa/enroll" className="font-medium text-indigo-600 hover:underline">
                Enable MFA
              </a>
            )}
            <button
              type="button"
              onClick={handleSignOut}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-slate-700 hover:bg-slate-50"
            >
              Sign out
            </button>
          </>
        )}
      </div>
    </header>
  )
}
