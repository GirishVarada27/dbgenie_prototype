import rateLimit from "express-rate-limit"

const WINDOW_MS = 15 * 60 * 1000

// Broad safety net across all /api routes.
export const generalLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
})

// Tighter: brute-force/credential-stuffing surface.
export const authLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many authentication requests. Try again later." },
})

// Tighter: each request calls the Gemini API and RAG retrieval — costly
// both financially and as a potential abuse vector.
export const chatLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many chat requests. Try again later." },
})
