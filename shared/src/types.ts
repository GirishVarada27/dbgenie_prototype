import type { OrgRole } from "./roles.js"

export type Engine = "postgres"

export type DatabaseInstanceStatus = "pending" | "active" | "unreachable" | "disabled"

export interface DatabaseInstance {
  id: string
  orgId: string
  name: string
  engine: Engine
  sslMode: string
  status: DatabaseInstanceStatus
  // Only set when the monitored database is itself Neon-hosted — enables
  // Stage 4 branch-based backup validation for this instance. null means
  // that feature is unavailable for it.
  neonProjectId: string | null
  createdAt: string
}

// Body for POST /api/orgs/:orgId/database-instances. Credentials are only
// ever sent, never returned — see backend/src/secrets/store.ts.
export interface CreateDatabaseInstanceInput {
  name: string
  host: string
  port: number
  database: string
  user: string
  password: string
  sslMode: string
  neonProjectId?: string
}

// Response body for POST .../database-instances/:id/sql/analyze. Text/DDL
// suggestion only — nothing here is ever executed by the server.
export interface SqlAnalysisResult {
  plan: unknown
  explanation: string
  rewrittenQuery: string | null
  indexDdl: string | null
  estimatedImprovementRange: string
  confidenceScore: number
}

export type BackupValidationStatus = "running" | "passed" | "failed"

export interface TableRowComparison {
  table: string
  expectedRows: number
  actualRows: number
  withinTolerance: boolean
}

export interface BackupValidationDetails {
  connectivityOk: boolean
  connectivityMessage: string
  branchId: string | null
  tableComparisons: TableRowComparison[]
  error?: string
}

export interface BackupValidation {
  id: string
  dbInstanceId: string
  status: BackupValidationStatus
  neonBranchId: string | null
  details: BackupValidationDetails
  createdAt: string
  completedAt: string | null
}

export interface Metric {
  id: string
  dbInstanceId: string
  metricName: string
  value: number
  ts: string
}

export type IncidentSeverity = "low" | "medium" | "high" | "critical"
export type IncidentStatus = "open" | "acknowledged" | "resolved"

export interface Incident {
  id: string
  dbInstanceId: string
  severity: IncidentSeverity
  rootCause: string | null
  confidenceScore: number | null
  requiresHumanReview: boolean
  status: IncidentStatus
  createdAt: string
}

export interface Recommendation {
  id: string
  incidentId: string
  agentSource: string
  actionText: string
  confidenceScore: number
  sources: ChatMessageSource[]
  createdAt: string
}

export interface RunbookChunk {
  id: string
  content: string
  sourceTitle: string
  createdAt: string
}

export interface ChatSession {
  id: string
  orgId: string
  userId: string
  title: string | null
  createdAt: string
}

export interface ChatMessageSource {
  chunkId: string
  sourceTitle: string
}

export interface ChatMessage {
  id: string
  sessionId: string
  role: "user" | "assistant"
  content: string
  sources: ChatMessageSource[]
  createdAt: string
}

export interface OrgMemberSummary {
  userId: string
  orgId: string
  role: OrgRole
  email: string
  name: string
}
