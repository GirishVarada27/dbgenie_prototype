import { describe, expect, it, vi } from "vitest"

vi.mock("../src/ai/gemini.js", () => ({
  genAI: {},
  GEMINI_MODEL: "test-model",
}))

const { diagnoseIncident } = await import("../src/ai/root-cause-agent.js")

import type { RetrievedChunk } from "../src/ai/retrieval.js"
import type { IncidentContext } from "../src/ai/root-cause-context.js"

const EMPTY_CONTEXT: IncidentContext = {
  metricsAtDetection: [],
  recentQueryActivity: null,
  schemaSummary: null,
  liveContextError: "not needed for this test",
}

function chunk(similarity: number, sourceTitle = "Some Runbook"): RetrievedChunk {
  return { id: crypto.randomUUID(), content: "content", sourceTitle, similarity }
}

describe("diagnoseIncident", () => {
  it("passes the model's own values through when retrieval is sufficient (>=2 relevant chunks)", async () => {
    const chunks = [chunk(0.8, "Connection Pool Saturation"), chunk(0.6, "Long-Running Queries")]
    const callModel = vi.fn().mockResolvedValue({
      rootCause: "Connections are saturated because of an idle-in-transaction leak.",
      confidenceScore: 0.85,
      recommendedActions: ["Terminate idle-in-transaction sessions", "Add PgBouncer"],
      requiresHumanReview: false,
    })

    const result = await diagnoseIncident("high", EMPTY_CONTEXT, chunks, callModel)

    expect(callModel).toHaveBeenCalledOnce()
    expect(result.confidenceScore).toBe(0.85)
    expect(result.requiresHumanReview).toBe(false)
    expect(result.citedSources).toHaveLength(2)
  })

  it("forces requiresHumanReview and caps confidence when fewer than 2 relevant chunks are retrieved", async () => {
    const chunks = [chunk(0.8, "Connection Pool Saturation")] // only 1 relevant chunk
    const callModel = vi.fn().mockResolvedValue({
      rootCause: "Probably connection saturation.",
      confidenceScore: 0.95, // model is confident...
      recommendedActions: ["Investigate further"],
      requiresHumanReview: false, // ...and doesn't think it needs review
    })

    const result = await diagnoseIncident("high", EMPTY_CONTEXT, chunks, callModel)

    // ...but the sparse-retrieval rule overrides both regardless of what
    // the model itself reported.
    expect(result.requiresHumanReview).toBe(true)
    expect(result.confidenceScore).toBeLessThanOrEqual(0.4)
  })

  it("forces requiresHumanReview and caps confidence when zero chunks are retrieved", async () => {
    const callModel = vi.fn().mockResolvedValue({
      rootCause: "Not enough context to say.",
      confidenceScore: 0.5,
      recommendedActions: [],
      requiresHumanReview: false,
    })

    const result = await diagnoseIncident("medium", EMPTY_CONTEXT, [], callModel)

    expect(result.requiresHumanReview).toBe(true)
    expect(result.confidenceScore).toBeLessThanOrEqual(0.4)
    expect(result.citedSources).toHaveLength(0)
  })

  it("filters out low-similarity chunks before counting relevance", async () => {
    // Two chunks retrieved, but only one clears the relevance threshold —
    // should be treated the same as "1 relevant chunk retrieved".
    const chunks = [chunk(0.8, "Connection Pool Saturation"), chunk(0.05, "Barely Related Runbook")]
    const callModel = vi.fn().mockResolvedValue({
      rootCause: "Diagnosis",
      confidenceScore: 0.9,
      recommendedActions: [],
      requiresHumanReview: false,
    })

    const result = await diagnoseIncident("high", EMPTY_CONTEXT, chunks, callModel)

    expect(result.requiresHumanReview).toBe(true)
    expect(result.citedSources).toHaveLength(1)
    expect(result.citedSources[0].sourceTitle).toBe("Connection Pool Saturation")
  })

  it("still requires human review if the model itself asks for it, even with sufficient relevant chunks", async () => {
    const chunks = [chunk(0.8, "Runbook A"), chunk(0.7, "Runbook B"), chunk(0.6, "Runbook C")]
    const callModel = vi.fn().mockResolvedValue({
      rootCause: "Ambiguous evidence.",
      confidenceScore: 0.5,
      recommendedActions: [],
      requiresHumanReview: true,
    })

    const result = await diagnoseIncident("low", EMPTY_CONTEXT, chunks, callModel)

    expect(result.requiresHumanReview).toBe(true)
    // Not sparse, so the model's own (uncapped) confidence passes through.
    expect(result.confidenceScore).toBe(0.5)
  })
})
