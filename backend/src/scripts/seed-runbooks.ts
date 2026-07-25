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

  // One embedding request for every chunk across every file, not one
  // request per file — Voyage's free-tier rate limit (3 requests/min
  // without a payment method) makes per-file batching fail on anything
  // more than a couple of runbooks.
  const embeddings = await embedTexts(
    pending.map((p) => p.content),
    "document",
  )

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
