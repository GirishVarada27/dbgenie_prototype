import { useEffect, useState, type FormEvent } from "react"
import { authClient } from "../lib/auth-client"
import { analyzeSql, fetchDatabaseInstances } from "../api/client"
import type { DatabaseInstance, SqlAnalysisResult } from "@dbgenie/shared"

interface PlanNode {
  "Node Type"?: string
  "Relation Name"?: string
  "Index Name"?: string
  "Total Cost"?: number
  "Plan Rows"?: number
  Plans?: PlanNode[]
  [key: string]: unknown
}

function planLines(node: PlanNode, depth = 0): string[] {
  const label = [node["Node Type"], node["Relation Name"] && `on ${node["Relation Name"]}`, node["Index Name"] && `using ${node["Index Name"]}`]
    .filter(Boolean)
    .join(" ")
  const cost = node["Total Cost"] !== undefined ? `  (cost=${node["Total Cost"]}, rows=${node["Plan Rows"] ?? "?"})` : ""
  const line = `${"  ".repeat(depth)}${label || "?"}${cost}`
  const children = (node.Plans ?? []).flatMap((child) => planLines(child, depth + 1))
  return [line, ...children]
}

function renderPlan(plan: unknown): string {
  try {
    const root = Array.isArray(plan) ? plan[0] : plan
    const planNode = (root as { Plan?: PlanNode })?.Plan
    if (!planNode) return JSON.stringify(plan, null, 2)
    return planLines(planNode).join("\n")
  } catch {
    return JSON.stringify(plan, null, 2)
  }
}

export default function SqlOptimizer() {
  const { data: activeOrg } = authClient.useActiveOrganization()
  const [instances, setInstances] = useState<DatabaseInstance[]>([])
  const [instanceId, setInstanceId] = useState("")
  const [sql, setSql] = useState("")
  const [result, setResult] = useState<SqlAnalysisResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!activeOrg?.id) return
    fetchDatabaseInstances(activeOrg.id)
      .then((rows) => {
        setInstances(rows)
        if (rows.length > 0) setInstanceId(rows[0].id)
      })
      .catch(() => setInstances([]))
  }, [activeOrg?.id])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!activeOrg?.id || !instanceId || !sql.trim()) return

    setLoading(true)
    setError(null)
    setResult(null)
    setCopied(false)

    try {
      const analysis = await analyzeSql(activeOrg.id, instanceId, sql)
      setResult(analysis)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not analyze this query.")
    } finally {
      setLoading(false)
    }
  }

  async function handleCopy(text: string) {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const ddlToCopy = result?.indexDdl || result?.rewrittenQuery || ""

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="mb-1 font-display text-xl font-semibold text-text-primary">SQL Optimizer</h1>
        <p className="text-sm text-text-secondary">
          Paste a query to get its execution plan and a suggestion. Nothing here is ever executed — read-only
          EXPLAIN and text/DDL output for you to review.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-6">
        <div>
          <label htmlFor="sql-instance" className="mb-1 block text-sm font-medium text-text-secondary">
            Database
          </label>
          <select
            id="sql-instance"
            value={instanceId}
            onChange={(e) => setInstanceId(e.target.value)}
            className="w-full max-w-sm rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
          >
            {instances.length === 0 && <option value="">No databases onboarded yet</option>}
            {instances.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="sql-query" className="mb-1 block text-sm font-medium text-text-secondary">
            Query
          </label>
          <textarea
            id="sql-query"
            value={sql}
            onChange={(e) => setSql(e.target.value)}
            rows={6}
            placeholder="SELECT ..."
            className="w-full rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
          />
        </div>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div>
          <button
            type="submit"
            disabled={loading || !instanceId || !sql.trim()}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-background hover:bg-accent/90 disabled:opacity-50"
          >
            {loading ? "Analyzing..." : "Analyze"}
          </button>
        </div>
      </form>

      {result && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="rounded-lg border border-border bg-surface p-6">
            <h2 className="mb-2 font-display text-sm font-semibold text-text-primary">Execution plan</h2>
            <pre className="overflow-x-auto rounded bg-surface-2 p-3 font-mono text-xs text-text-secondary">{renderPlan(result.plan)}</pre>
          </div>

          <div className="rounded-lg border border-border bg-surface p-6">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold text-text-primary">Suggestion</h2>
              <span className="font-mono text-xs text-accent">
                confidence: {Math.round(result.confidenceScore * 100)}%
              </span>
            </div>
            <p className="mb-3 text-sm text-text-primary">{result.explanation}</p>
            <p className="mb-3 text-xs text-text-secondary">
              Estimated improvement: <span className="font-mono">{result.estimatedImprovementRange}</span>
            </p>

            {(result.rewrittenQuery || result.indexDdl) && (
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <p className="text-xs font-medium tracking-wide text-text-secondary uppercase">
                    {result.indexDdl ? "Suggested index DDL" : "Suggested rewrite"}
                  </p>
                  <button
                    type="button"
                    onClick={() => handleCopy(ddlToCopy)}
                    className="text-xs font-medium text-accent hover:underline"
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre className="overflow-x-auto rounded bg-surface-2 p-3 font-mono text-xs text-text-secondary">{ddlToCopy}</pre>
              </div>
            )}

            {!result.rewrittenQuery && !result.indexDdl && (
              <p className="text-sm text-text-muted">No rewrite or index suggested.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
