// Anthropic doesn't offer an embeddings endpoint, so RAG uses Voyage AI
// (Anthropic's recommended embeddings partner) directly over its REST API
// — there's no official Voyage Node SDK, so this is a small fetch wrapper
// rather than an added dependency.
const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings"
const VOYAGE_MODEL = "voyage-3.5"

export type EmbeddingInputType = "document" | "query"

interface VoyageEmbeddingsResponse {
  data: { embedding: number[]; index: number }[]
}

function getApiKey(): string {
  const key = process.env.VOYAGE_API_KEY
  if (!key) {
    throw new Error("VOYAGE_API_KEY is not set. Copy .env.example to .env and add your Voyage AI API key.")
  }
  return key
}

// Batches in one request — Voyage accepts an array of inputs and returns
// embeddings in the same order. `inputType` matters: Voyage embeds
// documents and queries slightly differently for better retrieval quality,
// so runbook chunks (indexed once) use "document" and chat/incident
// queries (embedded per request) use "query".
export async function embedTexts(texts: string[], inputType: EmbeddingInputType): Promise<number[][]> {
  if (texts.length === 0) return []

  const res = await fetch(VOYAGE_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({
      input: texts,
      model: VOYAGE_MODEL,
      input_type: inputType,
      output_dimension: 1024,
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Voyage embeddings request failed (${res.status}): ${body}`)
  }

  const json = (await res.json()) as VoyageEmbeddingsResponse
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
}

export async function embedText(text: string, inputType: EmbeddingInputType): Promise<number[]> {
  const [embedding] = await embedTexts([text], inputType)
  return embedding
}
