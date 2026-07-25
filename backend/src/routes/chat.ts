import { Router } from "express"
import { and, eq } from "drizzle-orm"
import { ORG_ROLES, type ChatMessageSource } from "@dbgenie/shared"
import { db } from "../db.js"
import { chatMessages, chatSessions } from "../db/schema.js"
import { requireAuth } from "../middleware/require-auth.js"
import { requireRole } from "../middleware/require-role.js"
import { reqParam } from "../utils/params.js"
import { genAI, GEMINI_MODEL } from "../ai/gemini.js"
import { retrieveRunbookChunks } from "../ai/retrieval.js"
import { buildChatSystemPrompt } from "../ai/prompts.js"
import { logger } from "../logger.js"

const router = Router({ mergeParams: true })
router.use(requireAuth)

const TOP_K = 5

router.post("/", requireRole([...ORG_ROLES]), async (req, res) => {
  const orgId = reqParam(req.params.orgId)
  const userId = req.user!.id

  const message = typeof req.body?.message === "string" ? req.body.message.trim() : ""
  if (!message) {
    res.status(400).json({ error: "message is required." })
    return
  }

  const requestedSessionId =
    typeof req.body?.sessionId === "string" && req.body.sessionId ? req.body.sessionId : undefined

  let sessionId = requestedSessionId
  if (sessionId) {
    const [existing] = await db
      .select({ id: chatSessions.id })
      .from(chatSessions)
      .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.orgId, orgId), eq(chatSessions.userId, userId)))

    if (!existing) {
      res.status(404).json({ error: "Chat session not found." })
      return
    }
  } else {
    const [created] = await db
      .insert(chatSessions)
      .values({ orgId, userId, title: message.slice(0, 80) })
      .returning({ id: chatSessions.id })
    sessionId = created.id
  }

  await db.insert(chatMessages).values({ sessionId, role: "user", content: message, sources: [] })

  const chunks = await retrieveRunbookChunks(message, TOP_K)
  const sources: ChatMessageSource[] = chunks.map((c) => ({ chunkId: c.id, sourceTitle: c.sourceTitle }))

  res.setHeader("Content-Type", "text/event-stream")
  res.setHeader("Cache-Control", "no-cache")
  res.setHeader("Connection", "keep-alive")
  res.flushHeaders()

  res.write(`event: sources\ndata: ${JSON.stringify({ sessionId, sources })}\n\n`)

  const systemPrompt = buildChatSystemPrompt(chunks)
  let fullText = ""

  try {
    const stream = await genAI.interactions.create({
      model: GEMINI_MODEL,
      input: message,
      system_instruction: systemPrompt,
      stream: true,
      // thinking_level: low — Gemini 3's dynamic thinking is on by default
      // and shares the max_output_tokens budget with the visible response;
      // left at default it can eat most of a small budget before any
      // answer text streams out. gemini-flash-latest only accepts "low" or
      // "high" (see root-cause-agent.ts for the 400 error that confirmed
      // this — "minimal" is in the SDK's generic type but not accepted).
      generation_config: { max_output_tokens: 2048, thinking_level: "low" },
    })

    for await (const event of stream) {
      if (event.event_type === "step.delta" && event.delta.type === "text") {
        fullText += event.delta.text
        res.write(`event: token\ndata: ${JSON.stringify({ text: event.delta.text })}\n\n`)
      } else if (event.event_type === "error") {
        throw new Error(event.error?.message ?? "Gemini stream returned an error event.")
      }
    }
  } catch (err) {
    logger.error({ err, requestId: req.id, sessionId }, "Gemini chat request failed")
    res.write(
      `event: error\ndata: ${JSON.stringify({ error: "The AI assistant could not complete a response." })}\n\n`,
    )
    res.end()
    return
  }

  await db.insert(chatMessages).values({ sessionId, role: "assistant", content: fullText, sources })

  res.write(`event: done\ndata: ${JSON.stringify({ sessionId })}\n\n`)
  res.end()
})

export default router
