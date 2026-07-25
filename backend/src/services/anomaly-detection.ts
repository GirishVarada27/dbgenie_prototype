import type { MetricSample } from "../connectors/types.js"
import type { IncidentSeverity } from "@dbgenie/shared"

export interface AnomalyFinding {
  severity: IncidentSeverity
  reason: string
}

const CONNECTION_SATURATION_THRESHOLD = 0.8
const LONG_QUERY_THRESHOLD_SECONDS = 60

function findMetric(samples: MetricSample[], name: string): number | undefined {
  return samples.find((s) => s.metricName === name)?.value
}

// Stage 2 scope, verbatim: connections > 80% of max_connections, or any
// single query running > 60s. Root cause / recommendations are Stage 3 —
// this only decides whether an incident should exist.
export function detectAnomalies(samples: MetricSample[]): AnomalyFinding[] {
  const findings: AnomalyFinding[] = []

  const active = findMetric(samples, "active_connections")
  const max = findMetric(samples, "max_connections")
  if (active !== undefined && max !== undefined && max > 0) {
    const ratio = active / max
    if (ratio > CONNECTION_SATURATION_THRESHOLD) {
      findings.push({
        severity: "high",
        reason: `Active connections at ${active}/${max} (${Math.round(ratio * 100)}%), above the 80% threshold.`,
      })
    }
  }

  const longestQuerySeconds = findMetric(samples, "longest_running_query_seconds")
  if (longestQuerySeconds !== undefined && longestQuerySeconds > LONG_QUERY_THRESHOLD_SECONDS) {
    findings.push({
      severity: "medium",
      reason: `A query has been running for ${Math.round(longestQuerySeconds)}s, above the 60s threshold.`,
    })
  }

  return findings
}

const SEVERITY_RANK: Record<IncidentSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 }

export function worstSeverity(findings: AnomalyFinding[]): IncidentSeverity {
  return findings.reduce<IncidentSeverity>(
    (worst, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst] ? f.severity : worst),
    findings[0]?.severity ?? "low",
  )
}
