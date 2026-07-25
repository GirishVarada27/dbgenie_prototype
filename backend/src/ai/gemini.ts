import { GoogleGenAI } from "@google/genai"

if (!process.env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is not set. Copy .env.example to .env and add your Gemini API key.")
}

export const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

// "-latest" alias (confirmed against the installed @google/genai v2.13.0
// type definitions' Model union) so this tracks Google's current model
// rather than a dated/preview id that can be deprecated out from under it —
// Gemini 3 Pro Preview was shut down in favor of 3.1 only months after
// release, which is exactly the failure mode this avoids.
//
// Flash, not Pro: gemini-pro-latest resolved to gemini-3.1-pro, which
// returned "Quota exceeded ... limit: 0" on this API key's free tier —
// the Pro tier isn't available at all without billing enabled, unlike
// Flash. Override via GEMINI_MODEL (e.g. once billing is enabled and Pro's
// stronger reasoning is worth it for the Root Cause Agent specifically).
export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest"
