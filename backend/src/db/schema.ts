import { boolean, doublePrecision, jsonb, pgTable, text, timestamp, uuid, vector } from "drizzle-orm/pg-core"

// organizations/users/sessions/members are managed by Better Auth's own
// migration runner (see auth.ts + db/init.ts) — not modeled here. App
// tables reference org/user ids as plain text columns rather than formal
// FKs, since those rows live in a schema owned by a different migration
// tool that runs first but isn't guaranteed to stay perfectly in lockstep.

export const databaseInstances = pgTable("database_instances", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: text("org_id").notNull(),
  name: text("name").notNull(),
  engine: text("engine").notNull().default("postgres"),
  sslMode: text("ssl_mode").notNull().default("require"),
  status: text("status").notNull().default("pending"),
  // Only set when the monitored DB is itself Neon-hosted — enables Stage 4
  // branch-based backup validation (see queue/backup-validation-worker.ts).
  neonProjectId: text("neon_project_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

// One row per database_instances row (1:1) — connection credentials,
// pgcrypto-encrypted. See backend/src/secrets/store.ts for the only code
// allowed to read/write this table's encrypted_connection column.
export const secrets = pgTable("secrets", {
  id: uuid("id").primaryKey().defaultRandom(),
  dbInstanceId: uuid("db_instance_id")
    .notNull()
    .unique()
    .references(() => databaseInstances.id, { onDelete: "cascade" }),
  encryptedConnection: text("encrypted_connection").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const metrics = pgTable("metrics", {
  id: uuid("id").primaryKey().defaultRandom(),
  dbInstanceId: uuid("db_instance_id")
    .notNull()
    .references(() => databaseInstances.id, { onDelete: "cascade" }),
  metricName: text("metric_name").notNull(),
  value: doublePrecision("value").notNull(),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
})

export const incidents = pgTable("incidents", {
  id: uuid("id").primaryKey().defaultRandom(),
  dbInstanceId: uuid("db_instance_id")
    .notNull()
    .references(() => databaseInstances.id, { onDelete: "cascade" }),
  severity: text("severity").notNull(),
  rootCause: text("root_cause"),
  confidenceScore: doublePrecision("confidence_score"),
  requiresHumanReview: boolean("requires_human_review").notNull().default(false),
  status: text("status").notNull().default("open"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const recommendations = pgTable("recommendations", {
  id: uuid("id").primaryKey().defaultRandom(),
  incidentId: uuid("incident_id")
    .notNull()
    .references(() => incidents.id, { onDelete: "cascade" }),
  agentSource: text("agent_source").notNull(),
  actionText: text("action_text").notNull(),
  confidenceScore: doublePrecision("confidence_score").notNull(),
  sources: jsonb("sources").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

// 1024 dimensions matches Voyage AI's voyage-3.5 model (see
// backend/src/ai/embeddings.ts) — changing embedding models requires a
// migration since the column dimension is fixed.
export const runbookChunks = pgTable("runbook_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  content: text("content").notNull(),
  sourceTitle: text("source_title").notNull(),
  embedding: vector("embedding", { dimensions: 1024 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const chatSessions = pgTable("chat_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  orgId: text("org_id").notNull(),
  userId: text("user_id").notNull(),
  title: text("title"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => chatSessions.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  sources: jsonb("sources").notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const backupValidations = pgTable("backup_validations", {
  id: uuid("id").primaryKey().defaultRandom(),
  dbInstanceId: uuid("db_instance_id")
    .notNull()
    .references(() => databaseInstances.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("running"),
  neonBranchId: text("neon_branch_id"),
  details: jsonb("details").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
})

// Written only via the restricted `dbgenie_audit_writer` role (INSERT/
// SELECT granted, UPDATE/DELETE explicitly not) — see db/init.ts and
// middleware/audit-log.ts. The main app pool never writes here.
export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id"),
  orgId: text("org_id"),
  action: text("action").notNull(),
  targetEntity: text("target_entity").notNull(),
  beforeState: jsonb("before_state"),
  afterState: jsonb("after_state"),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})
