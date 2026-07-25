import { useEffect, useState } from "react"
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { authClient } from "../lib/auth-client"
import {
  fetchDatabaseInstanceMetrics,
  fetchDatabaseInstances,
  fetchIncidentRecommendations,
  fetchIncidents,
  type IncidentWithDatabaseName,
} from "../api/client"
import type { DatabaseInstance, Metric, Recommendation } from "@dbgenie/shared"

const SEVERITY_STYLES: Record<string, string> = {
  low: "bg-slate-100 text-slate-600",
  medium: "bg-amber-100 text-amber-700",
  high: "bg-orange-100 text-orange-700",
  critical: "bg-red-100 text-red-700",
}

function chartData(metrics: Metric[], metricName: string) {
  return metrics
    .filter((m) => m.metricName === metricName)
    .map((m) => ({
      time: new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      value: m.value,
    }))
}

function IncidentItem({ incident, orgId }: { incident: IncidentWithDatabaseName; orgId: string }) {
  const [open, setOpen] = useState(false)
  const [recommendations, setRecommendations] = useState<Recommendation[] | null>(null)

  async function handleToggle() {
    const next = !open
    setOpen(next)
    if (next && recommendations === null) {
      const rows = await fetchIncidentRecommendations(orgId, incident.id).catch(() => [])
      setRecommendations(rows)
    }
  }

  return (
    <li className="rounded-md border border-slate-100 px-2 py-1.5 text-sm">
      <button type="button" onClick={handleToggle} className="flex w-full items-center gap-2 text-left">
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLES[incident.severity]}`}>
          {incident.severity}
        </span>
        <span className="text-slate-600">{new Date(incident.createdAt).toLocaleString()}</span>
        {incident.rootCause === null ? (
          <span className="text-xs text-slate-400">Analyzing...</span>
        ) : (
          <span className="text-xs text-indigo-600">
            AI-generated, confidence: {Math.round((incident.confidenceScore ?? 0) * 100)}%
          </span>
        )}
        {incident.requiresHumanReview && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
            Needs human review
          </span>
        )}
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-2 border-t border-slate-100 pt-2">
          {incident.rootCause ? (
            <p className="text-sm text-slate-700">{incident.rootCause}</p>
          ) : (
            <p className="text-sm text-slate-400">
              The Root Cause Agent hasn't finished analyzing this incident yet.
            </p>
          )}

          {recommendations === null ? (
            <p className="text-xs text-slate-400">Loading recommendations...</p>
          ) : recommendations.length > 0 ? (
            <div>
              <p className="mb-1 text-xs font-medium text-slate-500">Recommended actions</p>
              <ul className="flex list-disc flex-col gap-1 pl-4">
                {recommendations.map((r) => (
                  <li key={r.id} className="text-sm text-slate-700">
                    {r.actionText}
                  </li>
                ))}
              </ul>
              {recommendations[0]?.sources.length > 0 && (
                <p className="mt-1 text-xs text-slate-400">
                  Sources: {recommendations[0].sources.map((s) => s.sourceTitle).join(", ")}
                </p>
              )}
            </div>
          ) : null}

          <p className="text-xs text-slate-400">
            AI-generated diagnosis — verify before acting, especially when flagged for human review.
          </p>
        </div>
      )}
    </li>
  )
}

function InstanceCard({
  instance,
  incidents,
  orgId,
}: {
  instance: DatabaseInstance
  incidents: IncidentWithDatabaseName[]
  orgId: string
}) {
  const [metrics, setMetrics] = useState<Metric[] | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      const rows = await fetchDatabaseInstanceMetrics(orgId, instance.id)
      if (!cancelled) setMetrics(rows)
    }

    load().catch(() => setMetrics([]))
    const interval = setInterval(() => load().catch(() => {}), 15_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [orgId, instance.id])

  const activeConnections = metrics ? chartData(metrics, "active_connections") : []
  const longestQuery = metrics ? chartData(metrics, "longest_running_query_seconds") : []

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">{instance.name}</h3>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
            instance.status === "active" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
          }`}
        >
          {instance.status}
        </span>
      </div>

      {metrics === null ? (
        <p className="text-sm text-slate-500">Loading metrics...</p>
      ) : metrics.length === 0 ? (
        <p className="text-sm text-slate-500">No metrics collected yet — first collection runs within 30s.</p>
      ) : (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-xs font-medium text-slate-500">Active connections</p>
            <ResponsiveContainer width="100%" height={140}>
              <LineChart data={activeConnections}>
                <XAxis dataKey="time" hide />
                <YAxis width={30} allowDecimals={false} />
                <Tooltip />
                <Line type="monotone" dataKey="value" stroke="#4f46e5" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-slate-500">Longest running query (s)</p>
            <ResponsiveContainer width="100%" height={140}>
              <LineChart data={longestQuery}>
                <XAxis dataKey="time" hide />
                <YAxis width={30} allowDecimals={false} />
                <Tooltip />
                <Line type="monotone" dataKey="value" stroke="#dc2626" dot={false} strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div className="mt-4">
        <p className="mb-2 text-xs font-medium text-slate-500">Open incidents</p>
        {incidents.length === 0 ? (
          <p className="text-sm text-slate-400">None</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {incidents.map((incident) => (
              <IncidentItem key={incident.id} incident={incident} orgId={orgId} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

export default function Health() {
  const { data: activeOrg } = authClient.useActiveOrganization()
  const orgId = activeOrg?.id

  const [instances, setInstances] = useState<DatabaseInstance[] | null>(null)
  const [openIncidents, setOpenIncidents] = useState<IncidentWithDatabaseName[]>([])

  useEffect(() => {
    if (!orgId) return
    let cancelled = false

    async function load() {
      const [instanceRows, incidentRows] = await Promise.all([
        fetchDatabaseInstances(orgId!),
        fetchIncidents(orgId!, "open"),
      ])
      if (!cancelled) {
        setInstances(instanceRows)
        setOpenIncidents(incidentRows)
      }
    }

    load().catch(() => setInstances([]))
    const interval = setInterval(() => load().catch(() => {}), 15_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [orgId])

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="mb-1 text-xl font-semibold text-slate-900">Health</h1>
        <p className="text-sm text-slate-500">Live metrics and open incidents, refreshed every 15 seconds.</p>
      </div>

      {!orgId || instances === null ? (
        <p className="text-sm text-slate-500">Loading...</p>
      ) : instances.length === 0 ? (
        <p className="text-sm text-slate-500">
          No databases onboarded yet — add one on the <span className="font-medium">Databases</span> page.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {instances.map((instance) => (
            <InstanceCard
              key={instance.id}
              instance={instance}
              incidents={openIncidents.filter((i) => i.dbInstanceId === instance.id)}
              orgId={orgId}
            />
          ))}
        </div>
      )}
    </div>
  )
}
