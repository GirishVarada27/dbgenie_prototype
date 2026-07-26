import type { IncidentContext } from "./root-cause-context.js"
import type { RetrievedChunk } from "./retrieval.js"

function formatContext(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) return "(no relevant runbook content was found)"

  return chunks
    .map((c, i) => `[Source ${i + 1}: ${c.sourceTitle}]\n${c.content}`)
    .join("\n\n---\n\n")
}

// Stage 5 hybrid grounding: when retrieval finds sufficiently relevant
// chunks (see GROUNDING_SIMILARITY_THRESHOLD in routes/chat.ts), answer
// strictly from them with citations, same as before. When it doesn't, the
// caller passes an empty array here — rather than refusing, the model may
// answer from general PostgreSQL knowledge, but the prompt forces it to
// label that plainly as ungrounded and forbids inventing [Source N]
// citations that don't exist. Never blend the two silently: a message is
// either grounded-with-citations or general-guidance, not both.
export function buildChatSystemPrompt(chunks: RetrievedChunk[]): string {
  if (chunks.length === 0) {
    return `You are DBGenie AI, a PostgreSQL database operations assistant.

No sufficiently relevant content was found in the organization's runbooks for this question. Answer from your own general PostgreSQL expertise instead of refusing, but begin your response with a short sentence making explicit that this answer is general guidance, not verified against the organization's own runbooks or incident history (e.g. "This isn't grounded in your runbooks — here's general PostgreSQL guidance:"). Do not invent or reference [Source N] citations — none were retrieved.`
  }

  return `You are DBGenie AI, a PostgreSQL database operations assistant.

Answer the user's question using the information in the CONTEXT section below. For every factual claim drawn from it, cite which source supports it using the format [Source N] matching the numbered sources below. Do not speculate beyond what the context supports.

If the context only partially answers the question, answer what it supports with citations, and if you add anything beyond it, state plainly that the addition is general knowledge rather than presenting it as verified against the context.

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
// MIN_RELEVANT_CHUNKS, which caps confidenceScore and forces
// requiresHumanReview regardless of what the model itself reports) — this
// prompt aims for the same behavior even when retrieval looks fine but the
// incident context itself is ambiguous.
//
// Stage 5 hybrid grounding: RUNBOOK CONTEXT can be thin or empty (sparse
// retrieval), same as chat. Rather than refusing, the model still proposes
// its best hypothesis using general PostgreSQL incident-diagnosis
// knowledge — the mechanical cap on confidenceScore/requiresHumanReview in
// diagnoseIncident() is what actually prevents a low-context hypothesis
// from masquerading as a confident, well-grounded one, not this prompt.
export function buildRootCauseSystemPrompt(severity: string, incidentContext: IncidentContext, chunks: RetrievedChunk[]): string {
  return `You are DBGenie AI's Root Cause Agent, diagnosing a PostgreSQL database incident.

Use the INCIDENT CONTEXT below, plus the RUNBOOK CONTEXT if any is provided, to form your diagnosis. If RUNBOOK CONTEXT is empty or thin, still propose your best hypothesis using general PostgreSQL incident-diagnosis knowledge rather than refusing — but say plainly in rootCause that it isn't verified against the organization's own runbooks, keep confidenceScore low, and set requiresHumanReview to true. Never state a cause the evidence doesn't support, and never cite a [Source N] that isn't listed below.

Respond with a JSON object with these fields: rootCause (string, citing [Source N] where applicable), confidenceScore (number, 0 to 1), recommendedActions (array of concrete, specific remediation steps), and requiresHumanReview (boolean). Be specific and reference concrete numbers from the context (exact connection counts, query durations, table sizes) rather than vague statements. If the evidence is ambiguous or incomplete, say so plainly in rootCause, set requiresHumanReview to true, and use a lower confidenceScore rather than guessing confidently.

INCIDENT CONTEXT:
${formatIncidentContext(severity, incidentContext)}

RUNBOOK CONTEXT:
${formatContext(chunks)}`
}
