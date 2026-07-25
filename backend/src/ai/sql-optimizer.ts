import { genAI, GEMINI_MODEL } from "./gemini.js"
import type { QueryPlan, SchemaSnapshot } from "../connectors/types.js"

export interface SqlOptimizationSuggestion {
  explanation: string
  rewrittenQuery: string | null
  indexDdl: string | null
  estimatedImprovementRange: string
  confidenceScore: number
}

interface RawSuggestion {
  explanation: string
  rewrittenQuery: string
  indexDdl: string
  estimatedImprovementRange: string
  confidenceScore: number
}

export type SqlOptimizerModelCaller = (systemPrompt: string) => Promise<RawSuggestion>

const SQL_OPTIMIZER_JSON_SCHEMA = {
  type: "object",
  properties: {
    explanation: {
      type: "string",
      description: "Plain-language explanation of the EXPLAIN plan's main cost driver.",
    },
    rewrittenQuery: {
      type: "string",
      description:
        "A rewritten version of the query that would improve performance. Empty string if an index suggestion is sufficient instead — never fill both unless clearly both are needed.",
    },
    indexDdl: {
      type: "string",
      description:
        "CREATE INDEX DDL that would improve performance. Empty string if a query rewrite is sufficient instead.",
    },
    estimatedImprovementRange: {
      type: "string",
      description:
        "An estimated improvement as a RANGE (e.g. '2-5x faster', '30-60% less execution time'), never a single precise number — you cannot benchmark this.",
    },
    confidenceScore: { type: "number", description: "0 to 1 confidence in this suggestion." },
  },
  required: ["explanation", "rewrittenQuery", "indexDdl", "estimatedImprovementRange", "confidenceScore"],
}

function buildSystemPrompt(sql: string, plan: QueryPlan, schema: SchemaSnapshot): string {
  const schemaText = schema.tables
    .slice(0, 25)
    .map(
      (t) =>
        `- ${t.schema}.${t.name} (~${t.approxRowCount} rows): ${t.indexes.map((i) => i.definition).join("; ") || "no indexes"}`,
    )
    .join("\n")

  return `You are DBGenie AI's SQL Optimizer, analyzing a single PostgreSQL query for a human engineer to review — you never execute anything yourself, only produce text/DDL suggestions.

QUERY:
${sql}

EXPLAIN (FORMAT JSON) PLAN:
${JSON.stringify(plan.plan)}

RELEVANT SCHEMA (tables and existing indexes):
${schemaText || "(no tables found)"}

Identify the plan's main cost driver in plain language, then suggest EITHER a rewritten query OR an index DDL statement — never both unless the plan clearly shows two independent problems. Give the estimated improvement as a range, never a single precise number, since you have not benchmarked it. Set confidenceScore lower if the schema context is sparse or the plan is ambiguous.`
}

const defaultCallModel: SqlOptimizerModelCaller = async (systemPrompt) => {
  const interaction = await genAI.interactions.create({
    model: GEMINI_MODEL,
    input: "Analyze this query and its plan using the context in your system prompt.",
    system_instruction: systemPrompt,
    generation_config: { max_output_tokens: 2048, thinking_level: "low" },
    response_format: { type: "text", mime_type: "application/json", schema: SQL_OPTIMIZER_JSON_SCHEMA },
  })

  const textBlock = interaction.steps
    .flatMap((step) => (step.type === "model_output" ? (step.content ?? []) : []))
    .find((block) => block.type === "text")

  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Gemini did not return a text response for SQL analysis.")
  }

  try {
    return JSON.parse(textBlock.text) as RawSuggestion
  } catch (err) {
    throw new Error(
      `Gemini's SQL optimizer response was not valid JSON (${err instanceof Error ? err.message : "parse error"}): ${textBlock.text.slice(0, 300)}`,
    )
  }
}

export async function analyzeSql(
  sql: string,
  plan: QueryPlan,
  schema: SchemaSnapshot,
  callModel: SqlOptimizerModelCaller = defaultCallModel,
): Promise<SqlOptimizationSuggestion> {
  const systemPrompt = buildSystemPrompt(sql, plan, schema)
  const result = await callModel(systemPrompt)

  return {
    explanation: result.explanation,
    rewrittenQuery: result.rewrittenQuery.trim() || null,
    indexDdl: result.indexDdl.trim() || null,
    estimatedImprovementRange: result.estimatedImprovementRange,
    confidenceScore: result.confidenceScore,
  }
}
