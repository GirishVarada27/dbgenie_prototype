// No tokenizer dependency for a prototype-scale seeding script — approximates
// tokens at ~4 chars/token (a standard rough heuristic for English text) to
// hit the "~500 tokens per chunk with overlap" target from the project doc.
const APPROX_CHARS_PER_TOKEN = 4
const TARGET_TOKENS = 500
const OVERLAP_TOKENS = 75

const TARGET_CHARS = TARGET_TOKENS * APPROX_CHARS_PER_TOKEN
const OVERLAP_CHARS = OVERLAP_TOKENS * APPROX_CHARS_PER_TOKEN

// Packs whole paragraphs into ~500-token chunks rather than cutting mid-
// sentence, carrying the tail of each chunk into the next for overlap. A
// single paragraph longer than the target size is kept whole rather than
// split further — fine for the runbook content this is built for.
export function chunkMarkdown(content: string): string[] {
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean)

  const chunks: string[] = []
  let current = ""

  for (const para of paragraphs) {
    if (current.length > 0 && current.length + para.length + 2 > TARGET_CHARS) {
      chunks.push(current)
      const overlap = current.slice(Math.max(0, current.length - OVERLAP_CHARS))
      current = `${overlap}\n\n${para}`
    } else {
      current = current ? `${current}\n\n${para}` : para
    }
  }

  if (current) chunks.push(current)

  return chunks
}
