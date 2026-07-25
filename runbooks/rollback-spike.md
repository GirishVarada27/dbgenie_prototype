# Runbook: Elevated Transaction Rollback Rate

## Symptoms

- `pg_stat_database.xact_rollback` growing much faster than usual relative
  to `xact_commit` — a rising rollback-to-commit ratio.
- This is a signal that something upstream is failing, not a Postgres
  performance problem in itself: rollbacks are usually the database
  faithfully reporting that the application (or a constraint) is rejecting
  work.

## Likely causes

1. **A recent deploy introduced a bug** that violates a constraint (unique,
   foreign key, check) on a code path that previously succeeded — every
   attempt now fails and rolls back.
2. **A downstream dependency failure inside a transaction** — e.g. an
   application makes an external API call mid-transaction, the call
   starts failing, and the app correctly rolls back the local transaction
   in response. The rollback spike here is an honest symptom of the real
   incident living outside Postgres.
3. **Deadlocks** (see the deadlocks runbook) — every deadlock produces
   exactly one rollback for the aborted side, so a deadlock spike shows up
   here too.
4. **Optimistic-concurrency-control conflicts** — application-level
   versioned updates (`WHERE version = $1`) that legitimately roll back
   and retry under contention; a moderate, steady rate of these can be
   normal rather than an incident, depending on the application.
5. **Statement or lock timeouts firing** more often than before, each
   producing a rollback, if `statement_timeout` /
   `idle_in_transaction_session_timeout` were recently tightened or query
   performance regressed (see long-running-queries runbook).

## Diagnosis

```sql
-- Commit vs rollback counts, current database
SELECT datname, xact_commit, xact_rollback,
       round(100.0 * xact_rollback / NULLIF(xact_commit + xact_rollback, 0), 2) AS rollback_pct
FROM pg_stat_database
WHERE datname = current_database();
```

Postgres itself cannot tell you *why* a transaction rolled back — that
context lives in the application's error logs or the client driver's error
output. Correlate the timing of the rollback-rate increase with:
- recent deploy timestamps,
- application error logs (constraint violation messages, external API
  failure logs),
- the deadlock log entries described in the deadlocks runbook.

## Resolution

- **If tied to a specific deploy**: this is an application bug, not a
  database issue — the fix is rolling back or patching the deploy, not
  tuning Postgres.
- **If tied to an external dependency outage**: the database is behaving
  correctly by rolling back; resolution lives in restoring the downstream
  dependency, and possibly adding circuit-breaking so failures there don't
  hold transactions open while retrying.
- **If tied to deadlocks**: follow the deadlocks runbook.
- **If it's expected optimistic-concurrency contention**: confirm the rate
  is within normal bounds for the feature rather than treating every
  rollback as a defect — some application designs rely on this pattern
  intentionally.

## When to escalate to a human

Because Postgres logs don't capture *why* the application chose to roll
back, a rollback-rate incident almost always needs an application-side
engineer to correlate with error logs — this is rarely something to
resolve purely at the database layer.
