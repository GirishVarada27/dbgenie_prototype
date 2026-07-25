import { useState, type FormEvent } from "react"
import type { ChatMessageSource } from "@dbgenie/shared"
import { authClient } from "../lib/auth-client"
import { streamChat } from "../api/client"

interface DisplayMessage {
  role: "user" | "assistant"
  content: string
  sources?: ChatMessageSource[]
}

export default function AiChat() {
  const { data: activeOrg } = authClient.useActiveOrganization()
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [input, setInput] = useState("")
  const [sessionId, setSessionId] = useState<string | undefined>()
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<number>>(new Set())

  function toggleExpanded(index: number) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const question = input.trim()
    if (!activeOrg?.id || !question || streaming) return

    setInput("")
    setError(null)
    setMessages((prev) => [...prev, { role: "user", content: question }, { role: "assistant", content: "" }])
    setStreaming(true)

    try {
      for await (const event of streamChat(activeOrg.id, { message: question, sessionId })) {
        if (event.type === "sources") {
          setSessionId(event.sessionId)
          setMessages((prev) => {
            const next = [...prev]
            next[next.length - 1] = { ...next[next.length - 1], sources: event.sources }
            return next
          })
        } else if (event.type === "token") {
          setMessages((prev) => {
            const next = [...prev]
            const last = next[next.length - 1]
            next[next.length - 1] = { ...last, content: last.content + event.text }
            return next
          })
        } else if (event.type === "error") {
          setError(event.error)
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chat request failed.")
    } finally {
      setStreaming(false)
    }
  }

  return (
    <div className="flex h-[calc(100vh-6rem)] flex-col">
      <h1 className="mb-1 text-xl font-semibold text-slate-900">AI Chat</h1>
      <p className="mb-4 text-sm text-slate-500">
        Ask about an incident or general PostgreSQL troubleshooting — answers are grounded in your seeded runbooks.
      </p>

      <div className="flex-1 overflow-y-auto rounded-lg border border-slate-200 bg-white p-4">
        {messages.length === 0 ? (
          <p className="text-sm text-slate-400">No messages yet — ask a question below.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {messages.map((m, i) => (
              <div key={i} className={m.role === "user" ? "text-right" : ""}>
                <div
                  className={`inline-block max-w-[85%] rounded-lg px-3 py-2 text-left text-sm ${
                    m.role === "user" ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-800"
                  }`}
                >
                  <p className="whitespace-pre-wrap">
                    {m.content || (streaming && i === messages.length - 1 ? "…" : "")}
                  </p>
                </div>
                {m.role === "assistant" && m.sources && m.sources.length > 0 && (
                  <div className="mt-1 text-left">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(i)}
                      className="text-xs font-medium text-indigo-600 hover:underline"
                    >
                      {expanded.has(i) ? "Hide sources" : `${m.sources.length} source${m.sources.length > 1 ? "s" : ""}`}
                    </button>
                    {expanded.has(i) && (
                      <ul className="mt-1 flex flex-col gap-1">
                        {m.sources.map((s, sourceIndex) => (
                          <li key={s.chunkId} className="text-xs text-slate-500">
                            [Source {sourceIndex + 1}] {s.sourceTitle}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}

      <form onSubmit={handleSubmit} className="mt-4 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={streaming || !activeOrg}
          placeholder="Ask about an incident or PostgreSQL troubleshooting..."
          className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={streaming || !input.trim() || !activeOrg}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {streaming ? "Thinking..." : "Send"}
        </button>
      </form>
    </div>
  )
}
