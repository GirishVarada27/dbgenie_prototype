import type { IncidentContext } from "./root-cause-context.js"
import type { RetrievedChunk } from "./retrieval.js"

function formatContext(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "(no relevant runbook content was found)"

  return chunks
    .map((c, i) => `[Source ${i + 1}: ${c.sourceTitle}]\n${c.content}`)
    .join("\n\n---\n\n")
}

// Grounds the chat answer strictly in retrieved runbook content — the
// project doc requires citing sources and explicitly admitting insufficient
// context rather than falling back to the model's general PostgreSQL
// knowledge, which would be ungrounded and unverifiable for an ops tool.
export function buildChatSystemPrompt(chunks: RetrievedChunk[]): string {
  return `You are DBGenie AI, a PostgreSQL database operations assistant.

Answer the user's question using ONLY the information in the CONTEXT section below. Do not use any other knowledge about PostgreSQL, even if you know it, and do not speculate beyond what the context supports.

For every factual claim, cite which source supports it using the format [Source N] matching the numbered sources below.

If the context does not contain enough information to answer the question, say so explicitly rather than guessing — do not fill gaps with general knowledge.

CONTEXT:
${formatContext(chunks)}`
}

function formatIncidentContext(severity: string, context: IncidentContext): string {
  const metricsText = context.metricsAtDetection.length
    ? context.metricsAtDetection.map((m) => `- ${m.metricName}: ${m.value}`).join("\n")
    : "(no metrics were recorded for this instance before the incident)"

  const queryActivityText = context.recentQueryActivity
    ? context.recentQueryActivity.length
      ? context.recentQueryActivity
          .map((q) => `- running ${q.runningForSeconds}s: ${q.query.slice(0, 300)}`)
          .join("\n")
      : "(no active queries at the time of this check)"
    : `(live query activity unavailable: ${context.liveContextError})`

  const schemaText = context.schemaSummary
    ? context.schemaSummary.map((t) => `- ${t.name}: ~${t.approxRowCount} rows, ${t.indexCount} index(es)`).join("\n")
    : `(schema snapshot unavailable: ${context.liveContextError})`

  return `Severity: ${severity}

Metrics at time of detection:
${metricsText}

Recent query activity (live, at time of analysis — may differ from the moment of detection):
${queryActivityText}

Database schema summary:
${schemaText}`
}

// The actual JSON-validity enforcement comes from Gemini's response_format
// (see ai/root-cause-agent.ts), not this prompt — this just explains the
// expected fields and tells the model to hedge (lower confidence,
// requiresHumanReview) when evidence is thin, rather than confidently
// guessing. The worker separately *enforces* the same hedging for weak
// retrieval (see root-cause-agent.ts's RELEVANCE_SIMILARITY_THRESHOLD/
// MIN_RELEVANT_CHUNKS) — this prompt aims for the same behavior even when
// retrieval looks fine but the incident context itself is ambiguous.
export function buildRootCauseSystemPrompt(severity: string, incidentContext: IncidentContext, chunks: RetrievedChunk[]): string {
  return `You are DBGenie AI's Root Cause Agent, diagnosing a PostgreSQL database incident.

Use ONLY the INCIDENT CONTEXT and RUNBOOK CONTEXT below to form your diagnosis — do not rely on general PostgreSQL knowledge beyond what's provided, and do not state a cause the evidence doesn't actually support.

Respond with a JSON object with these fields: rootCause (string, citing [Source N] where applicable), confidenceScore (number, 0 to 1), recommendedActions (array of concrete, specific remediation steps), and requiresHumanReview (boolean). Be specific and reference concrete numbers from the context (exact connection counts, query durations, table sizes) rather than vague statements. If the evidence is ambiguous, incomplete, or the runbook context is thin, say so plainly in rootCause, set requiresHumanReview to true, and use a lower confidenceScore rather than guessing confidently.

INCIDENT CONTEXT:
${formatIncidentContext(severity, incidentContext)}

RUNBOOK CONTEXT:
${formatContext(chunks)}`
}
