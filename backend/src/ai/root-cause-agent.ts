import { genAI, GEMINI_MODEL } from "./gemini.js"
import { buildRootCauseSystemPrompt } from "./prompts.js"
import type { RetrievedChunk } from "./retrieval.js"
import type { IncidentContext } from "./root-cause-context.js"

export interface RootCauseDiagnosis {
  rootCause: string
  confidenceScore: number
  recommendedActions: string[]
  requiresHumanReview: boolean
  citedSources: { chunkId: string; sourceTitle: string }[]
}

export interface ModelDiagnosisResult {
  rootCause: string
  confidenceScore: number
  recommendedActions: string[]
  requiresHumanReview: boolean
}

export type DiagnosisModelCaller = (systemPrompt: string) => Promise<ModelDiagnosisResult>

const MIN_RELEVANT_CHUNKS = 2
// pgvector always returns the nearest K neighbors regardless of how weak
// the match is, so raw topK count alone isn't a meaningful relevance
// signal — this floor decides what counts as "relevant" for the doc's
// "fewer than 2 relevant chunks" rule. Rough heuristic, not empirically
// tuned against a labeled dataset.
const RELEVANCE_SIMILARITY_THRESHOLD = 0.3
const CAPPED_CONFIDENCE_WHEN_SPARSE = 0.4

const ROOT_CAUSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    rootCause: {
      type: "string",
      description: "Plain-language explanation of the most likely root cause, citing [Source N] where applicable.",
    },
    confidenceScore: { type: "number", description: "0 to 1 confidence in this diagnosis." },
    recommendedActions: {
      type: "array",
      items: { type: "string" },
      description: "Concrete, specific remediation steps.",
    },
    requiresHumanReview: {
      type: "boolean",
      description: "True if a human should verify this before acting on it.",
    },
  },
  required: ["rootCause", "confidenceScore", "recommendedActions", "requiresHumanReview"],
}

// Uses Gemini's JSON-schema-constrained response_format rather than
// function-calling — the project doc asks for "valid JSON output" directly,
// and this guarantees the response body itself is schema-valid JSON rather
// than requiring a tool-call round trip to get the same result.
const defaultCallModel: DiagnosisModelCaller = async (systemPrompt) => {
  const interaction = await genAI.interactions.create({
    model: GEMINI_MODEL,
    input: "Diagnose this incident using the context in your system prompt.",
    system_instruction: systemPrompt,
    // thinking_level: low + a generous max_output_tokens — Gemini 3's
    // dynamic thinking is on by default and consumes from the same output
    // token budget as the response; at max_output_tokens: 1024 the model
    // spent nearly the whole budget "thinking" and got cut off 106
    // characters into the JSON, which then failed to parse. "minimal" is
    // in the SDK's generic ThinkingLevel type but gemini-flash-latest only
    // accepts "low" or "high" — confirmed via the actual 400 error body.
    generation_config: { max_output_tokens: 2048, thinking_level: "low" },
    response_format: { type: "text", mime_type: "application/json", schema: ROOT_CAUSE_JSON_SCHEMA },
  })

  const textBlock = interaction.steps
    .flatMap((step) => (step.type === "model_output" ? (step.content ?? []) : []))
    .find((block) => block.type === "text")

  if (!textBlock || textBlock.type !== "text") {
    throw new Error("Gemini did not return a text response for root cause analysis.")
  }

  try {
    return JSON.parse(textBlock.text) as ModelDiagnosisResult
  } catch (err) {
    throw new Error(
      `Gemini's root cause response was not valid JSON (${err instanceof Error ? err.message : "parse error"}): ${textBlock.text.slice(0, 300)}`,
    )
  }
}

// Pure decision logic, separated from Gemini/DB plumbing so it's directly
// unit-testable (see tests/root-cause-agent.test.ts) — in particular the
// "fewer than 2 relevant chunks retrieved forces requiresHumanReview + a
// capped confidence score" rule from the project doc, which must hold
// regardless of what the model itself reports.
export async function diagnoseIncident(
  severity: string,
  incidentContext: IncidentContext,
  allChunks: RetrievedChunk[],
  callModel: DiagnosisModelCaller = defaultCallModel,
): Promise<RootCauseDiagnosis> {
  const relevantChunks = allChunks.filter((c) => c.similarity >= RELEVANCE_SIMILARITY_THRESHOLD)
  const systemPrompt = buildRootCauseSystemPrompt(severity, incidentContext, relevantChunks)

  const result = await callModel(systemPrompt)

  const sparse = relevantChunks.length < MIN_RELEVANT_CHUNKS
  const requiresHumanReview = sparse || result.requiresHumanReview
  const confidenceScore = sparse
    ? Math.min(result.confidenceScore, CAPPED_CONFIDENCE_WHEN_SPARSE)
    : result.confidenceScore

  return {
    rootCause: result.rootCause,
    confidenceScore,
    recommendedActions: result.recommendedActions,
    requiresHumanReview,
    citedSources: relevantChunks.map((c) => ({ chunkId: c.id, sourceTitle: c.sourceTitle })),
  }
}
