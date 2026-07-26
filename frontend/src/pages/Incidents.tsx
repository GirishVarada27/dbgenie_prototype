import { useEffect, useMemo, useState } from "react"
import { authClient } from "../lib/auth-client"
import {
  fetchDatabaseInstances,
  fetchIncidentRecommendations,
  fetchIncidents,
  type IncidentWithDatabaseName,
} from "../api/client"
import type { DatabaseInstance, Recommendation } from "@dbgenie/shared"

const SEVERITY_STYLES: Record<string, string> = {
  low: "bg-surface-2 text-text-secondary",
  medium: "bg-warning/15 text-warning",
  high: "bg-warning/15 text-warning",
  critical: "bg-danger/15 text-danger",
}

const STATUS_TABS: { value: string | undefined; label: string }[] = [
  { value: "open", label: "Open" },
  { value: undefined, label: "All" },
]

function IncidentDetail({ incident, orgId }: { incident: IncidentWithDatabaseName; orgId: string }) {
  const [recommendations, setRecommendations] = useState<Recommendation[] | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchIncidentRecommendations(orgId, incident.id)
      .then((rows) => {
        if (!cancelled) setRecommendations(rows)
      })
      .catch(() => {
        if (!cancelled) setRecommendations([])
      })
    return () => {
      cancelled = true
    }
  }, [orgId, incident.id])

  return (
    <div className="flex flex-col gap-3 border-t border-border bg-surface-2 px-4 py-4">
      {incident.rootCause ? (
        <p className="text-sm leading-relaxed text-text-primary">{incident.rootCause}</p>
      ) : (
        <p className="text-sm text-text-muted">The Root Cause Agent hasn't finished analyzing this incident yet.</p>
      )}

      {recommendations === null ? (
        <p className="text-xs text-text-muted">Loading recommendations...</p>
      ) : recommendations.length > 0 ? (
        <div>
          <p className="mb-1 text-xs font-medium tracking-wide text-text-secondary uppercase">Recommended actions</p>
          <ul className="flex list-disc flex-col gap-1 pl-4">
            {recommendations.map((r) => (
              <li key={r.id} className="text-sm text-text-primary">
                {r.actionText}
              </li>
            ))}
          </ul>
          {recommendations[0]?.sources.length > 0 && (
            <p className="mt-1 text-xs text-text-muted">
              Sources: {recommendations[0].sources.map((s) => s.sourceTitle).join(", ")}
            </p>
          )}
        </div>
      ) : null}

      <p className="text-xs text-text-muted">
        AI-generated diagnosis — verify before acting, especially when flagged for human review.
      </p>
    </div>
  )
}

function IncidentRow({ incident, orgId }: { incident: IncidentWithDatabaseName; orgId: string }) {
  const [open, setOpen] = useState(false)

  return (
    <li className="rounded-lg border border-border bg-surface">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_STYLES[incident.severity]}`}>
          {incident.severity}
        </span>
        <span className="font-medium text-text-primary">{incident.databaseName}</span>
        <span className="font-mono text-xs text-text-secondary">{new Date(incident.createdAt).toLocaleString()}</span>
        <span className="ml-auto flex items-center gap-2">
          {incident.rootCause === null ? (
            <span className="text-xs text-text-muted">Analyzing...</span>
          ) : (
            <span className="font-mono text-xs text-accent">{Math.round((incident.confidenceScore ?? 0) * 100)}% confidence</span>
          )}
          {incident.requiresHumanReview && (
            <span className="rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">Needs review</span>
          )}
          <span className="text-xs text-text-muted">{open ? "▲" : "▼"}</span>
        </span>
      </button>
      {open && <IncidentDetail incident={incident} orgId={orgId} />}
    </li>
  )
}

export default function Incidents() {
  const { data: activeOrg } = authClient.useActiveOrganization()
  const orgId = activeOrg?.id

  const [instances, setInstances] = useState<DatabaseInstance[]>([])
  const [incidents, setIncidents] = useState<IncidentWithDatabaseName[] | null>(null)
  const [statusFilter, setStatusFilter] = useState<string | undefined>("open")
  const [instanceFilter, setInstanceFilter] = useState<string>("")

  useEffect(() => {
    if (!orgId) return
    fetchDatabaseInstances(orgId).then(setInstances).catch(() => setInstances([]))
  }, [orgId])

  useEffect(() => {
    if (!orgId) return
    let cancelled = false

    function load() {
      fetchIncidents(orgId!, statusFilter)
        .then((rows) => {
          if (!cancelled) setIncidents(rows)
        })
        .catch(() => {
          if (!cancelled) setIncidents([])
        })
    }

    load()
    const interval = setInterval(load, 15_000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [orgId, statusFilter])

  const visible = useMemo(
    () => (incidents ?? []).filter((i) => !instanceFilter || i.dbInstanceId === instanceFilter),
    [incidents, instanceFilter],
  )

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="mb-1 font-display text-xl font-semibold text-text-primary">Incidents</h1>
        <p className="text-sm text-text-secondary">Anomalies detected across your monitored databases.</p>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <div className="flex rounded-md border border-border p-0.5">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.label}
              type="button"
              onClick={() => setStatusFilter(tab.value)}
              className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
                statusFilter === tab.value ? "bg-accent text-background" : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {instances.length > 0 && (
          <select
            value={instanceFilter}
            onChange={(e) => setInstanceFilter(e.target.value)}
            className="rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-text-primary focus:border-accent focus:outline-none"
          >
            <option value="">All databases</option>
            {instances.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {!orgId || incidents === null ? (
        <p className="text-sm text-text-secondary">Loading...</p>
      ) : visible.length === 0 ? (
        <p className="text-sm text-text-secondary">No incidents match this filter.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map((incident) => (
            <IncidentRow key={incident.id} incident={incident} orgId={orgId} />
          ))}
        </ul>
      )}
    </div>
  )
}
