// Thin wrapper over the Neon API v2 (https://api-docs.neon.tech/reference)
// for Stage 4's backup validation: create a temporary branch, get a
// connection string for it, tear it down again. Only the handful of
// endpoints backup-validation-worker.ts needs — not a general-purpose SDK.
const NEON_API_BASE = "https://console.neon.tech/api/v2"

function getApiKey(): string {
  const key = process.env.NEON_API_KEY
  if (!key) {
    throw new Error("NEON_API_KEY is not set. Copy .env.example to .env and add your Neon API key.")
  }
  return key
}

async function neonFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${NEON_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Neon API request failed (${res.status} ${path}): ${body}`)
  }

  return res.json() as Promise<T>
}

export interface NeonBranch {
  id: string
  name: string
  default: boolean
  parent_id?: string
}

export interface NeonOperation {
  id: string
  status: string
}

export interface NeonDatabase {
  name: string
  owner_name: string
}

export async function getDefaultBranch(projectId: string): Promise<NeonBranch> {
  const { branches } = await neonFetch<{ branches: NeonBranch[] }>(`/projects/${projectId}/branches`)
  const defaultBranch = branches.find((b) => b.default)
  if (!defaultBranch) {
    throw new Error(`No default branch found for Neon project ${projectId}.`)
  }
  return defaultBranch
}

export async function listDatabases(projectId: string, branchId: string): Promise<NeonDatabase[]> {
  const { databases } = await neonFetch<{ databases: NeonDatabase[] }>(
    `/projects/${projectId}/branches/${branchId}/databases`,
  )
  return databases
}

export async function createBranch(
  projectId: string,
  parentBranchId: string,
  name: string,
): Promise<{ branch: NeonBranch; operations: NeonOperation[] }> {
  return neonFetch(`/projects/${projectId}/branches`, {
    method: "POST",
    body: JSON.stringify({
      branch: { parent_id: parentBranchId, name },
      endpoints: [{ type: "read_write" }],
    }),
  })
}

// Branch creation is async on Neon's side — poll until every operation
// from the create call has finished before trying to connect.
export async function waitForOperations(
  projectId: string,
  operations: NeonOperation[],
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const pending = new Set(operations.map((op) => op.id))

  while (pending.size > 0) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for Neon operations to finish: ${[...pending].join(", ")}`)
    }

    for (const opId of [...pending]) {
      const { operation } = await neonFetch<{ operation: NeonOperation }>(
        `/projects/${projectId}/operations/${opId}`,
      )
      if (operation.status === "finished") pending.delete(opId)
    }

    if (pending.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  }
}

export async function getConnectionUri(
  projectId: string,
  branchId: string,
  databaseName: string,
  roleName: string,
): Promise<string> {
  const params = new URLSearchParams({ branch_id: branchId, database_name: databaseName, role_name: roleName })
  const { uri } = await neonFetch<{ uri: string }>(`/projects/${projectId}/connection_uri?${params}`)
  return uri
}

export async function deleteBranch(projectId: string, branchId: string): Promise<void> {
  await neonFetch(`/projects/${projectId}/branches/${branchId}`, { method: "DELETE" })
}
