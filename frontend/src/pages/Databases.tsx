import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { authClient } from "../lib/auth-client"
import {
  createDatabaseInstance,
  deleteDatabaseInstance,
  fetchBackupValidations,
  fetchDatabaseInstances,
  runBackupValidation,
  testDatabaseInstanceConnection,
} from "../api/client"
import type { BackupValidation, DatabaseInstance } from "@dbgenie/shared"

const STATUS_STYLES: Record<DatabaseInstance["status"], string> = {
  active: "bg-emerald-100 text-emerald-700",
  pending: "bg-slate-100 text-slate-600",
  unreachable: "bg-red-100 text-red-700",
  disabled: "bg-slate-100 text-slate-400",
}

const VALIDATION_STATUS_STYLES: Record<BackupValidation["status"], string> = {
  running: "bg-slate-100 text-slate-600",
  passed: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
}

const emptyForm = {
  name: "",
  host: "",
  port: "5432",
  database: "",
  user: "",
  password: "",
  sslMode: "require",
  neonProjectId: "",
}

function BackupValidationPanel({ orgId, instance }: { orgId: string; instance: DatabaseInstance }) {
  const [runs, setRuns] = useState<BackupValidation[] | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    const rows = await fetchBackupValidations(orgId, instance.id)
    setRuns(rows)
    return rows
  }, [orgId, instance.id])

  useEffect(() => {
    if (expanded) load().catch(() => setRuns([]))
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [expanded, load])

  async function handleRun() {
    setError(null)
    try {
      await runBackupValidation(orgId, instance.id)
      setExpanded(true)
      const rows = await load()
      // Poll while the most recent run is still 'running'.
      if (rows[0]?.status === "running") {
        pollRef.current = setInterval(async () => {
          const latest = await load()
          if (latest[0]?.status !== "running" && pollRef.current) {
            clearInterval(pollRef.current)
          }
        }, 5000)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start backup validation.")
    }
  }

  const latest = runs?.[0]

  return (
    <div className="mt-2 border-t border-slate-100 pt-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleRun}
          disabled={latest?.status === "running"}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          {latest?.status === "running" ? "Validating..." : "Run backup validation"}
        </button>
        {latest && (
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${VALIDATION_STATUS_STYLES[latest.status]}`}>
            {latest.status}
          </span>
        )}
        <button type="button" onClick={() => setExpanded((v) => !v)} className="text-xs text-indigo-600 hover:underline">
          {expanded ? "Hide history" : "History"}
        </button>
      </div>

      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}

      {expanded && (
        <ul className="mt-2 flex flex-col gap-2">
          {runs === null ? (
            <p className="text-xs text-slate-400">Loading...</p>
          ) : runs.length === 0 ? (
            <p className="text-xs text-slate-400">No validation runs yet.</p>
          ) : (
            runs.map((run) => (
              <li key={run.id} className="rounded-md bg-slate-50 p-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 font-medium ${VALIDATION_STATUS_STYLES[run.status]}`}>
                    {run.status}
                  </span>
                  <span className="text-slate-500">{new Date(run.createdAt).toLocaleString()}</span>
                </div>
                {run.status !== "running" && (
                  <div className="mt-1 text-slate-600">
                    {run.details.error && <p className="text-red-600">{run.details.error}</p>}
                    <p>
                      Connectivity: {run.details.connectivityOk ? "ok" : "failed"}
                      {run.details.connectivityMessage ? ` — ${run.details.connectivityMessage}` : ""}
                    </p>
                    {run.details.tableComparisons.length > 0 && (
                      <ul className="mt-1 flex flex-col gap-0.5">
                        {run.details.tableComparisons.map((c) => (
                          <li key={c.table} className={c.withinTolerance ? "" : "text-red-600"}>
                            {c.table}: expected ~{c.expectedRows}, branch had {c.actualRows}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}

export default function Databases() {
  const { data: activeOrg } = authClient.useActiveOrganization()
  const orgId = activeOrg?.id

  const [instances, setInstances] = useState<DatabaseInstance[] | null>(null)
  const [form, setForm] = useState(emptyForm)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  async function reload(currentOrgId: string) {
    const rows = await fetchDatabaseInstances(currentOrgId)
    setInstances(rows)
  }

  useEffect(() => {
    if (!orgId) return
    reload(orgId).catch((err) => setError(err instanceof Error ? err.message : "Could not load databases."))
  }, [orgId])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!orgId) return
    setError(null)
    setSubmitting(true)

    try {
      await createDatabaseInstance(orgId, {
        name: form.name,
        host: form.host,
        port: Number(form.port),
        database: form.database,
        user: form.user,
        password: form.password,
        sslMode: form.sslMode,
        neonProjectId: form.neonProjectId.trim() || undefined,
      })
      setForm(emptyForm)
      await reload(orgId)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add database.")
    } finally {
      setSubmitting(false)
    }
  }

  async function handleTest(id: string) {
    if (!orgId) return
    setBusyId(id)
    setError(null)
    try {
      await testDatabaseInstanceConnection(orgId, id)
      await reload(orgId)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not test connection.")
    } finally {
      setBusyId(null)
    }
  }

  async function handleDelete(id: string) {
    if (!orgId) return
    setBusyId(id)
    setError(null)
    try {
      await deleteDatabaseInstance(orgId, id)
      await reload(orgId)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove database.")
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="mb-1 text-xl font-semibold text-slate-900">Databases</h1>
        <p className="text-sm text-slate-500">
          Connect a Postgres database to start collecting health metrics every 30 seconds.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="grid max-w-2xl grid-cols-2 gap-4 rounded-lg border border-slate-200 bg-white p-6"
      >
        <div className="col-span-2">
          <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="db-name">
            Display name
          </label>
          <input
            id="db-name"
            required
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            placeholder="Production Postgres"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="db-host">
            Host
          </label>
          <input
            id="db-host"
            required
            value={form.host}
            onChange={(e) => setForm({ ...form, host: e.target.value })}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            placeholder="ep-example.aws.neon.tech"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="db-port">
            Port
          </label>
          <input
            id="db-port"
            type="number"
            required
            value={form.port}
            onChange={(e) => setForm({ ...form, port: e.target.value })}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="db-database">
            Database
          </label>
          <input
            id="db-database"
            required
            value={form.database}
            onChange={(e) => setForm({ ...form, database: e.target.value })}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="db-sslmode">
            SSL mode
          </label>
          <select
            id="db-sslmode"
            value={form.sslMode}
            onChange={(e) => setForm({ ...form, sslMode: e.target.value })}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
          >
            <option value="require">require</option>
            <option value="disable">disable</option>
          </select>
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="db-user">
            User
          </label>
          <input
            id="db-user"
            required
            value={form.user}
            onChange={(e) => setForm({ ...form, user: e.target.value })}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="db-password">
            Password
          </label>
          <input
            id="db-password"
            type="password"
            required
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div className="col-span-2">
          <label className="mb-1 block text-sm font-medium text-slate-700" htmlFor="db-neon-project">
            Neon project ID <span className="font-normal text-slate-400">(optional — enables backup validation)</span>
          </label>
          <input
            id="db-neon-project"
            value={form.neonProjectId}
            onChange={(e) => setForm({ ...form, neonProjectId: e.target.value })}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            placeholder="Only if this database is hosted on Neon"
          />
        </div>

        {error && <p className="col-span-2 text-sm text-red-600">{error}</p>}

        <div className="col-span-2">
          <button
            type="submit"
            disabled={submitting || !orgId}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {submitting ? "Testing connection..." : "Test connection & add"}
          </button>
        </div>
      </form>

      <div>
        <h2 className="mb-3 text-sm font-semibold text-slate-700">Onboarded databases</h2>
        {instances === null ? (
          <p className="text-sm text-slate-500">Loading...</p>
        ) : instances.length === 0 ? (
          <p className="text-sm text-slate-500">No databases yet — add one above.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {instances.map((instance) => (
              <li key={instance.id} className="rounded-lg border border-slate-200 bg-white px-4 py-3">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-slate-900">{instance.name}</p>
                    <p className="text-xs text-slate-500">
                      {instance.engine} · ssl {instance.sslMode}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLES[instance.status]}`}>
                      {instance.status}
                    </span>
                    <button
                      type="button"
                      disabled={busyId === instance.id}
                      onClick={() => handleTest(instance.id)}
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      Test
                    </button>
                    <button
                      type="button"
                      disabled={busyId === instance.id}
                      onClick={() => handleDelete(instance.id)}
                      className="rounded-md border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                </div>

                {instance.neonProjectId && orgId && <BackupValidationPanel orgId={orgId} instance={instance} />}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
