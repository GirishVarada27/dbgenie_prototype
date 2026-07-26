import "../load-env.js"
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { db, pool } from "../db.js"
import { runbookChunks } from "../db/schema.js"
import { chunkMarkdown } from "../ai/chunking.js"
import { embedTexts } from "../ai/embeddings.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// backend/src/scripts/seed-runbooks.ts -> repo root -> runbooks/
const defaultRunbooksDir = path.join(__dirname, "..", "..", "..", "runbooks")

interface PendingChunk {
  content: string
  sourceTitle: string
}

async function main() {
  const dir = process.argv[2] || process.env.RUNBOOKS_DIR || defaultRunbooksDir
  const entries = await fs.readdir(dir)
  const files = entries.filter((f) => f.endsWith(".md")).sort()

  if (files.length === 0) {
    console.error(`No .md files found in ${dir}`)
    process.exit(1)
  }

  console.log(`Seeding runbooks from ${dir} (${files.length} file(s))`)

  const pending: PendingChunk[] = []

  for (const file of files) {
    const raw = await fs.readFile(path.join(dir, file), "utf-8")
    const titleMatch = raw.match(/^#\s+(.+)$/m)
    const sourceTitle = titleMatch ? titleMatch[1].trim() : file

    const chunks = chunkMarkdown(raw)
    console.log(`  ${file}: ${chunks.length} chunk(s)`)
    for (const content of chunks) pending.push({ content, sourceTitle })
  }

  // Batched, but capped per request — Voyage's free tier (no payment
  // method on file) enforces both 3 requests/minute AND 10K tokens/minute.
  // A single request for every chunk across every file fit under 10K
  // tokens with the original 7-runbook seed set, but Stage 5's expanded
  // 15-runbook corpus (~16K tokens across ~32 chunks) doesn't — it 429s
  // with "reduced rate limits" even as a single request. Splitting into
  // ~8K-token batches and pacing them ~21s apart (same spacing
  // tests/rag-retrieval.test.ts uses) keeps every request under both caps.
  const MAX_TOKENS_PER_BATCH = 8000
  const APPROX_CHARS_PER_TOKEN = 4
  const BATCH_PAUSE_MS = 21_000

  const batches: PendingChunk[][] = []
  let currentBatch: PendingChunk[] = []
  let currentBatchTokens = 0

  for (const chunk of pending) {
    const chunkTokens = Math.ceil(chunk.content.length / APPROX_CHARS_PER_TOKEN)
    if (currentBatch.length > 0 && currentBatchTokens + chunkTokens > MAX_TOKENS_PER_BATCH) {
      batches.push(currentBatch)
      currentBatch = []
      currentBatchTokens = 0
    }
    currentBatch.push(chunk)
    currentBatchTokens += chunkTokens
  }
  if (currentBatch.length > 0) batches.push(currentBatch)

  const embeddings: number[][] = []
  for (let i = 0; i < batches.length; i++) {
    if (i > 0) {
      console.log(`  Pausing ${BATCH_PAUSE_MS / 1000}s to stay under Voyage's free-tier rate limits...`)
      await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS))
    }
    console.log(`  Embedding batch ${i + 1}/${batches.length} (${batches[i].length} chunk(s))...`)
    const batchEmbeddings = await embedTexts(
      batches[i].map((p) => p.content),
      "document",
    )
    embeddings.push(...batchEmbeddings)
  }

  // Re-seedable: clear previously seeded chunks first so re-running after
  // editing a runbook doesn't leave stale duplicates behind. Deleted only
  // after embeddings succeed so a failed run doesn't leave the table empty.
  await db.delete(runbookChunks)

  await db.insert(runbookChunks).values(
    pending.map((p, i) => ({
      content: p.content,
      sourceTitle: p.sourceTitle,
      embedding: embeddings[i],
    })),
  )

  console.log(`Seeded ${pending.length} chunk(s) from ${files.length} runbook(s).`)
  await pool.end()
}

main().catch((err) => {
  console.error("Seeding failed:", err)
  process.exit(1)
})
