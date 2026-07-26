import { useState, type FormEvent } from "react"
import type { ChatMessageSource } from "@dbgenie/shared"
import { authClient } from "../lib/auth-client"
import { streamChat } from "../api/client"

interface DisplayMessage {
  role: "user" | "assistant"
  content: string
  // Hybrid grounding (Stage 5 Part C): undefined until the "sources" event
  // arrives, then either a non-empty array (grounded, cited) or an empty
  // one (general guidance) — see the badge rendered below per message.
  sources?: ChatMessageSource[]
}

function TypingIndicator() {
  return (
    <div className="inline-flex items-center gap-1 rounded-lg bg-surface-2 px-3 py-2.5">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.3s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.15s]" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent" />
    </div>
  )
}

export default function AiChat() {
  const { data: activeOrg } = authClient.useActiveOrganization()
  const [messages, setMessages] = useState<DisplayMessage[]>([])
  const [input, setInput] = useState("")
  const [sessionId, setSessionId] = useState<string | undefined>()
  const [streaming, setStreaming] = useState(false)
  const [waitingForFirstToken, setWaitingForFirstToken] = useState(false)
  const [connectionNotice, setConnectionNotice] = useState<string | null>(null)
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

  // Runs one attempt at streaming a reply into the last (assistant)
  // message, and reports back whether the server ever sent a "done"/"error"
  // terminal event. If the stream just stops short of that — the SSE
  // connection dropped mid-response — the caller retries once rather than
  // silently leaving the answer truncated (Stage 5 Part B).
  async function runStream(question: string, sessionIdAtStart: string | undefined): Promise<boolean> {
    let reachedTerminal = false
    let gotFirstToken = false

    for await (const event of streamChat(activeOrg!.id, { message: question, sessionId: sessionIdAtStart })) {
      if (event.type === "sources") {
        setSessionId(event.sessionId)
        setMessages((prev) => {
          const next = [...prev]
          next[next.length - 1] = { ...next[next.length - 1], sources: event.sources }
          return next
        })
      } else if (event.type === "token") {
        if (!gotFirstToken) {
          gotFirstToken = true
          setWaitingForFirstToken(false)
        }
        setMessages((prev) => {
          const next = [...prev]
          const last = next[next.length - 1]
          next[next.length - 1] = { ...last, content: last.content + event.text }
          return next
        })
      } else if (event.type === "error") {
        reachedTerminal = true
        setError(event.error)
      } else if (event.type === "done") {
        reachedTerminal = true
      }
    }

    return reachedTerminal
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const question = input.trim()
    if (!activeOrg?.id || !question || streaming) return

    setInput("")
    setError(null)
    setConnectionNotice(null)
    setMessages((prev) => [...prev, { role: "user", content: question }, { role: "assistant", content: "" }])
    setStreaming(true)
    setWaitingForFirstToken(true)

    try {
      const reachedTerminal = await runStream(question, sessionId)

      if (!reachedTerminal) {
        // Connection dropped before the server sent "done"/"error" —
        // retry exactly once, resuming the same session so we don't
        // duplicate the user's message.
        setConnectionNotice("Connection interrupted — retrying...")
        setWaitingForFirstToken(true)
        const retryReachedTerminal = await runStream(question, sessionId)
        setConnectionNotice(null)
        if (!retryReachedTerminal) {
          setError("Connection interrupted. Please try sending your message again.")
        }
      }
    } catch (err) {
      setConnectionNotice(null)
      setError(err instanceof Error ? err.message : "Chat request failed.")
    } finally {
      setStreaming(false)
      setWaitingForFirstToken(false)
    }
  }

  return (
    <div className="flex h-[calc(100vh-6rem)] flex-col">
      <h1 className="mb-1 font-display text-xl font-semibold text-text-primary">AI Chat</h1>
      <p className="mb-4 text-sm text-text-secondary">
        Ask about an incident or general PostgreSQL troubleshooting — answers grounded in your runbooks are cited;
        others are clearly labeled as general guidance.
      </p>

      <div className="flex-1 overflow-y-auto rounded-lg border border-border bg-surface p-4">
        {messages.length === 0 ? (
          <p className="text-sm text-text-muted">No messages yet — ask a question below.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {messages.map((m, i) => {
              const isLast = i === messages.length - 1
              const showTyping = m.role === "assistant" && isLast && waitingForFirstToken && !m.content

              return (
                <div key={i} className={m.role === "user" ? "text-right" : ""}>
                  {showTyping ? (
                    <TypingIndicator />
                  ) : (
                    <div
                      className={`inline-block max-w-[85%] rounded-lg px-3 py-2 text-left text-sm ${
                        m.role === "user" ? "bg-accent text-background" : "bg-surface-2 text-text-primary"
                      }`}
                    >
                      <p className="whitespace-pre-wrap">{m.content}</p>
                    </div>
                  )}
                  {m.role === "assistant" && m.sources && (
                    <div className="mt-1 text-left">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase ${
                          m.sources.length > 0 ? "bg-accent/15 text-accent" : "bg-surface-2 text-text-muted"
                        }`}
                      >
                        {m.sources.length > 0 ? "Grounded in your docs" : "General guidance"}
                      </span>
                      {m.sources.length > 0 && (
                        <button
                          type="button"
                          onClick={() => toggleExpanded(i)}
                          className="ml-2 text-xs font-medium text-accent hover:underline"
                        >
                          {expanded.has(i) ? "Hide sources" : `${m.sources.length} source${m.sources.length > 1 ? "s" : ""}`}
                        </button>
                      )}
                      {expanded.has(i) && (
                        <ul className="mt-1 flex flex-col gap-1">
                          {m.sources.map((s, sourceIndex) => (
                            <li key={s.chunkId} className="text-xs text-text-secondary">
                              [Source {sourceIndex + 1}] {s.sourceTitle}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {connectionNotice && <p className="mt-2 text-sm text-warning">{connectionNotice}</p>}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}

      <form onSubmit={handleSubmit} className="mt-4 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={streaming || !activeOrg}
          placeholder="Ask about an incident or PostgreSQL troubleshooting..."
          className="flex-1 rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={streaming || !input.trim() || !activeOrg}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-background hover:bg-accent/90 disabled:opacity-50"
        >
          {streaming ? "Thinking..." : "Send"}
        </button>
      </form>
    </div>
  )
}
