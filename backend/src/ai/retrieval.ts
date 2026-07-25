import { sql } from "drizzle-orm"
import { db } from "../db.js"
import { runbookChunks } from "../db/schema.js"
import { embedText } from "./embeddings.js"

export interface RetrievedChunk {
  id: string
  content: string
  sourceTitle: string
  similarity: number
}

// Shared by both /chat and the Root Cause Agent. pgvector's `<=>` operator
// is cosine distance; similarity = 1 - distance is the usual convention for
// display/thresholding.
//
// The project doc also mentions retrieving from past resolved incidents
// "once any exist" — deferred for now (a fresh prototype has none to
// retrieve from yet); runbook_chunks is the only corpus searched today.
export async function retrieveRunbookChunks(queryText: string, topK = 5): Promise<RetrievedChunk[]> {
  const queryEmbedding = await embedText(queryText, "query")
  const embeddingLiteral = `[${queryEmbedding.join(",")}]`
  const distance = sql<number>`${runbookChunks.embedding} <=> ${embeddingLiteral}::vector`

  const rows = await db
    .select({
      id: runbookChunks.id,
      content: runbookChunks.content,
      sourceTitle: runbookChunks.sourceTitle,
      distance,
    })
    .from(runbookChunks)
    .orderBy(distance)
    .limit(topK)

  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    sourceTitle: r.sourceTitle,
    similarity: 1 - r.distance,
  }))
}
