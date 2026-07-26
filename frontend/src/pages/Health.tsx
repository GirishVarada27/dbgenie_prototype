import { useEffect, useState } from "react"
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Link } from "react-router-dom"
import { authClient } from "../lib/auth-client"
import { fetchDatabaseInstanceMetrics, fetchDatabaseInstances, fetchIncidents, type IncidentWithDatabaseName } from "../api/client"
import type { DatabaseInstance, Metric } from "@dbgenie/shared"

const SEVERITY_DOT: Record<string, string> = {
  low: "bg-text-muted",
  medium: "bg-warning",
  high: "bg-warning",
  critical: "bg-danger",
}

// Recharts renders onto a transparent SVG canvas, so the dark theme comes
// entirely from the stroke/fill colors passed to each chart element — no
// Recharts-level "theme" prop exists.
const CHART_GRID = "#232B3D"
const CHART_AXIS = "#8B93A7"
const CHART_LINE_PRIMARY = "#2DD4BF"
const CHART_LINE_SECONDARY = "#F59E0B"

const TOOLTIP_STYLE = {
  background: "#121826",
  border: "1px solid #232B3D",
  borderRadius: 6,
  fontSize: 12,
  fontFamily: "JetBrains Mono, monospace",
  color: "#E6E9EF",
}

function chartData(metrics: Metric[], metricName: string) {
  return metrics
    .filter((m) => m.metricName === metricName)
    .map((m) => ({
      time: new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      value: m.value,
    }))
}

function MetricChart({ label, data, color }: { label: string; data: { time: string; value: number }[]; color: string }) {
  const latest = data.length > 0 ? data[data.length - 1].value : null

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <p className="text-xs font-medium tracking-wide text-text-secondary uppercase">{label}</p>
        <p className="font-mono text-sm text-text-primary">{latest === null ? "--" : latest}</p>
      </div>
      <ResponsiveContainer width="100%" height={140}>
        <LineChart data={data}>
          <CartesianGrid stroke={CHART_GRID} strokeOpacity={0.5} vertical={false} />
          <XAxis dataKey="time" hide />
          <YAxis width={30} allowDecimals={false} stroke={CHART_AXIS} tick={{ fontSize: 10, fontFamily: "JetBrains Mono, monospace" }} />
          <Tooltip contentStyle={TOOLTIP_STYLE} labelStyle={{ color: CHART_AXIS }} />
          <Line type="monotone" dataKey="value" stroke={color} dot={false} strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function InstanceCard({ instance, incidents }: { instance: DatabaseInstance; incidents: IncidentWithDatabaseName[] }) {
  const [metrics, setMetrics] = useState<Metric[] | null>(null)
  const { data: activeOrg } = authClient.useActiveOrganization()
  const orgId = activeOrg?.id

  useEffect(() => {
    if (!orgId) return
    let cancelled = false

    async function load() {
      const rows = await fetchDatabaseInstanceMetrics(orgId!, instance.id)
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
    <div className="rounded-lg border border-border bg-surface p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-display text-sm font-semibold text-text-primary">{instance.name}</h3>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
            instance.status === "active" ? "bg-accent/15 text-accent" : "bg-danger/15 text-danger"
          }`}
        >
          {instance.status}
        </span>
      </div>

      {metrics === null ? (
        <p className="text-sm text-text-secondary">Loading metrics...</p>
      ) : metrics.length === 0 ? (
        <p className="text-sm text-text-secondary">No metrics collected yet — first collection runs within 30s.</p>
      ) : (
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <MetricChart label="Active connections" data={activeConnections} color={CHART_LINE_PRIMARY} />
          <MetricChart label="Longest running query (s)" data={longestQuery} color={CHART_LINE_SECONDARY} />
        </div>
      )}

      <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
        <div className="flex items-center gap-2">
          {incidents.length === 0 ? (
            <span className="text-sm text-text-muted">No open incidents</span>
          ) : (
            <>
              <span className="flex -space-x-0.5">
                {incidents.slice(0, 5).map((i) => (
                  <span key={i.id} className={`h-2 w-2 rounded-full ring-2 ring-surface ${SEVERITY_DOT[i.severity]}`} />
                ))}
              </span>
              <span className="font-mono text-sm text-text-primary">{incidents.length}</span>
              <span className="text-sm text-text-secondary">open incident{incidents.length > 1 ? "s" : ""}</span>
            </>
          )}
        </div>
        {incidents.length > 0 && (
          <Link to="/incidents" className="text-xs font-medium text-accent hover:underline">
            View in Incidents →
          </Link>
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
        <h1 className="mb-1 font-display text-xl font-semibold text-text-primary">Health</h1>
        <p className="text-sm text-text-secondary">Live metrics and open incidents, refreshed every 15 seconds.</p>
      </div>

      {!orgId || instances === null ? (
        <p className="text-sm text-text-secondary">Loading...</p>
      ) : instances.length === 0 ? (
        <p className="text-sm text-text-secondary">
          No databases onboarded yet — add one on the <span className="font-medium text-text-primary">Databases</span> page.
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {instances.map((instance) => (
            <InstanceCard
              key={instance.id}
              instance={instance}
              incidents={openIncidents.filter((i) => i.dbInstanceId === instance.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
