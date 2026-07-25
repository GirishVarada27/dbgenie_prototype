import { useState, type FormEvent } from "react"
import { Link, useNavigate } from "react-router-dom"
import { authClient } from "../lib/auth-client"

export default function MfaEnroll() {
  const [password, setPassword] = useState("")
  const [code, setCode] = useState("")
  const [totpUri, setTotpUri] = useState<string | null>(null)
  const [backupCodes, setBackupCodes] = useState<string[]>([])
  const [verified, setVerified] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()

  async function handleEnable(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    const { data, error: enableError } = await authClient.twoFactor.enable({ password })
    setLoading(false)

    if (enableError) {
      setError(enableError.message ?? "Could not start two-factor enrollment.")
      return
    }

    setTotpUri(data?.totpURI ?? null)
    setBackupCodes(data?.backupCodes ?? [])
  }

  async function handleVerify(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    const { error: verifyError } = await authClient.twoFactor.verifyTotp({ code })
    setLoading(false)

    if (verifyError) {
      setError(verifyError.message ?? "Invalid code. Check your authenticator app and try again.")
      return
    }

    setVerified(true)
  }

  if (verified) {
    return (
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="mb-2 text-xl font-semibold text-slate-900">Two-factor authentication enabled</h1>
        <p className="mb-6 text-sm text-slate-500">
          Your account is now protected with an authenticator app in addition to your password.
        </p>
        <button
          type="button"
          onClick={() => navigate("/")}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
        >
          Go to dashboard
        </button>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-md py-12">
      <h1 className="mb-1 text-xl font-semibold text-slate-900">Enable two-factor authentication</h1>
      <p className="mb-6 text-sm text-slate-500">Add TOTP-based MFA using an authenticator app.</p>

      {!totpUri ? (
        <form onSubmit={handleEnable} className="flex flex-col gap-4">
          <div>
            <label htmlFor="mfa-password" className="mb-1 block text-sm font-medium text-slate-700">
              Confirm your password
            </label>
            <input
              id="mfa-password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {loading ? "Starting enrollment..." : "Continue"}
          </button>
        </form>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
            <p className="mb-2 text-sm font-medium text-slate-700">
              Scan this in your authenticator app, or enter the setup URI manually:
            </p>
            <p className="break-all rounded bg-white p-2 font-mono text-xs text-slate-600">{totpUri}</p>
          </div>

          {backupCodes.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-4">
              <p className="mb-2 text-sm font-medium text-amber-800">
                Save these backup codes somewhere safe. Each can be used once if you lose access to your
                authenticator app.
              </p>
              <ul className="grid grid-cols-2 gap-1 font-mono text-xs text-amber-900">
                {backupCodes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </div>
          )}

          <form onSubmit={handleVerify} className="flex flex-col gap-4">
            <div>
              <label htmlFor="mfa-code" className="mb-1 block text-sm font-medium text-slate-700">
                Enter the 6-digit code from your app
              </label>
              <input
                id="mfa-code"
                type="text"
                inputMode="numeric"
                required
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
              />
            </div>

            {error && <p className="text-sm text-red-600">{error}</p>}

            <button
              type="submit"
              disabled={loading}
              className="rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
            >
              {loading ? "Verifying..." : "Verify and enable"}
            </button>
          </form>
        </div>
      )}

      <Link to="/" className="mt-6 inline-block text-sm text-slate-500 hover:underline">
        Skip for now
      </Link>
    </div>
  )
}
