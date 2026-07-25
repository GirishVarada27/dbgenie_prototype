import "../src/load-env.js"
import { beforeEach, describe, expect, it } from "vitest"
import { db } from "../src/db.js"
import { runbookChunks } from "../src/db/schema.js"
import { retrieveRunbookChunks } from "../src/ai/retrieval.js"

// Integration test: needs a real Voyage embedding call and a seeded
// runbook_chunks table (`npm run seed:runbooks`) — skips cleanly rather
// than failing when either prerequisite is missing, same pattern as
// postgres-connector.test.ts's Docker-less DB dependency.
//
// `seeded` is resolved via top-level await (not beforeAll) specifically so
// describe.skipIf can see the real value — skipIf/it.skipIf conditions are
// evaluated synchronously at collection time, before any hook runs, so a
// beforeAll-computed flag would always read its stale initial value.
const canRunBase = Boolean(process.env.VOYAGE_API_KEY && process.env.DATABASE_URL)

let seeded = false
if (canRunBase) {
  try {
    const rows = await db.select({ id: runbookChunks.id }).from(runbookChunks).limit(1)
    seeded = rows.length > 0
  } catch {
    // Table may not exist yet in an unmigrated CI database — treat the
    // same as "not seeded" rather than failing the whole suite.
    seeded = false
  }
  if (!seeded) {
    console.warn("runbook_chunks is empty — run `npm run seed:runbooks` before this test can verify retrieval.")
  }
}

describe.skipIf(!canRunBase || !seeded)("retrieveRunbookChunks", () => {
  // Each test makes one real Voyage embedding call. Voyage's free tier
  // (no payment method on file) caps requests at 3/minute — spacing calls
  // ~21s apart keeps every run under that regardless of account tier,
  // rather than the suite intermittently 429ing on faster machines/accounts.
  let testIndex = 0
  beforeEach(async () => {
    if (testIndex > 0) {
      await new Promise((resolve) => setTimeout(resolve, 21_000))
    }
    testIndex++
  }, 25_000)

  it("returns the connection-pool-saturation runbook for a connections-maxed-out query", async () => {
    const results = await retrieveRunbookChunks(
      "Why are we running out of database connections? active_connections is at 95% of max_connections.",
      5,
    )

    expect(results.length).toBeGreaterThan(0)
    expect(results.some((r) => r.sourceTitle.toLowerCase().includes("connection pool"))).toBe(true)
  })

  it("returns the long-running-queries runbook for a slow, blocking query question", async () => {
    const results = await retrieveRunbookChunks(
      "A query has been running for 90 seconds and other queries seem stuck behind it, what should I check?",
      5,
    )

    expect(results.length).toBeGreaterThan(0)
    expect(results.some((r) => r.sourceTitle.toLowerCase().includes("long-running"))).toBe(true)
  })

  it("returns the replication-lag runbook for a stale-replica question", async () => {
    const results = await retrieveRunbookChunks(
      "Our read replica is returning data that's several minutes out of date compared to the primary.",
      5,
    )

    expect(results.length).toBeGreaterThan(0)
    expect(results.some((r) => r.sourceTitle.toLowerCase().includes("replication lag"))).toBe(true)
  })

  it("orders results by descending similarity", async () => {
    const results = await retrieveRunbookChunks("deadlock detected between two transactions", 5)

    for (let i = 1; i < results.length; i++) {
      expect(results[i].similarity).toBeLessThanOrEqual(results[i - 1].similarity)
    }
  })
})
