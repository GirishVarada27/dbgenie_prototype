import type {
  BackupValidation,
  ChatMessageSource,
  CreateDatabaseInstanceInput,
  DatabaseInstance,
  Incident,
  Metric,
  Recommendation,
  SqlAnalysisResult,
} from "@dbgenie/shared"

// In dev, Vite proxies /api to the backend (see vite.config.ts), so a
// relative base works. In prod the frontend is a separate static site from
// the API web service (see render.yaml), so VITE_API_BASE_URL must point at
// the API's public URL.
const BASE = `${import.meta.env.VITE_API_BASE_URL ?? ""}/api`

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    // Required so the Better Auth session cookie is sent even when the
    // frontend and API are separate origins in prod (see README).
    credentials: "include",
    ...options,
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Request failed with status ${res.status}`)
  }

  return res.status === 204 ? (null as T) : res.json()
}

export default request

// The /incidents list endpoint joins in the database's name for display —
// not part of the base shared Incident shape, which mirrors the DB row.
export interface IncidentWithDatabaseName extends Incident {
  databaseName: string
}

export const fetchDatabaseInstances = (orgId: string) =>
  request<DatabaseInstance[]>(`/orgs/${orgId}/database-instances`)

export const createDatabaseInstance = (orgId: string, payload: CreateDatabaseInstanceInput) =>
  request<DatabaseInstance>(`/orgs/${orgId}/database-instances`, {
    method: "POST",
    body: JSON.stringify(payload),
  })

export const testDatabaseInstanceConnection = (orgId: string, id: string) =>
  request<{ ok: boolean; message: string; status: string }>(
    `/orgs/${orgId}/database-instances/${id}/test-connection`,
    { method: "POST" },
  )

export const deleteDatabaseInstance = (orgId: string, id: string) =>
  request<null>(`/orgs/${orgId}/database-instances/${id}`, { method: "DELETE" })

export const fetchDatabaseInstanceMetrics = (orgId: string, id: string, limit?: number) =>
  request<Metric[]>(`/orgs/${orgId}/database-instances/${id}/metrics${limit ? `?limit=${limit}` : ""}`)

export const fetchIncidents = (orgId: string, status?: string) =>
  request<IncidentWithDatabaseName[]>(`/orgs/${orgId}/incidents${status ? `?status=${status}` : ""}`)

export const fetchIncidentRecommendations = (orgId: string, incidentId: string) =>
  request<Recommendation[]>(`/orgs/${orgId}/incidents/${incidentId}/recommendations`)

export const analyzeSql = (orgId: string, instanceId: string, sql: string) =>
  request<SqlAnalysisResult>(`/orgs/${orgId}/database-instances/${instanceId}/sql/analyze`, {
    method: "POST",
    body: JSON.stringify({ sql }),
  })

export const fetchBackupValidations = (orgId: string, instanceId: string) =>
  request<BackupValidation[]>(`/orgs/${orgId}/database-instances/${instanceId}/backup-validations`)

export const runBackupValidation = (orgId: string, instanceId: string) =>
  request<BackupValidation>(`/orgs/${orgId}/database-instances/${instanceId}/backup-validations`, {
    method: "POST",
  })

export type ChatStreamEvent =
  | { type: "sources"; sessionId: string; sources: ChatMessageSource[] }
  | { type: "token"; text: string }
  | { type: "error"; error: string }
  | { type: "done"; sessionId: string }

// The generic `request()` wrapper assumes a single JSON response, so /chat
// (Server-Sent Events) gets its own fetch call here instead — SSE responses
// aren't `EventSource`-compatible for POST-with-body requests, so this
// parses the `event:`/`data:` frames off the raw stream by hand.
export async function* streamChat(
  orgId: string,
  payload: { message: string; sessionId?: string },
): AsyncGenerator<ChatStreamEvent> {
  const res = await fetch(`${BASE}/orgs/${orgId}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(payload),
  })

  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `Request failed with status ${res.status}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let separatorIndex: number
    while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, separatorIndex)
      buffer = buffer.slice(separatorIndex + 2)

      const lines = rawEvent.split("\n")
      const eventLine = lines.find((l) => l.startsWith("event:"))
      const dataLine = lines.find((l) => l.startsWith("data:"))
      if (!eventLine || !dataLine) continue

      const eventName = eventLine.slice("event:".length).trim()
      const data = JSON.parse(dataLine.slice("data:".length).trim())

      if (eventName === "sources") yield { type: "sources", sessionId: data.sessionId, sources: data.sources }
      else if (eventName === "token") yield { type: "token", text: data.text }
      else if (eventName === "error") yield { type: "error", error: data.error }
      else if (eventName === "done") yield { type: "done", sessionId: data.sessionId }
    }
  }
}
