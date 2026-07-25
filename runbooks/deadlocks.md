# Runbook: Deadlocks

## Symptoms

- Application logs show Postgres errors like
  `deadlock detected` / `ERROR: deadlock detected` (SQLSTATE `40P01`).
- One of two (or more) concurrent transactions is automatically aborted by
  Postgres; the other proceeds normally.
- Deadlocks tend to cluster around specific application flows that touch
  the same set of rows/tables from multiple code paths concurrently (e.g.
  a transfer between two accounts, or a many-to-many join table updated
  from both directions).

## Likely causes

Postgres detects true deadlocks automatically and resolves them by killing
one participant — so a deadlock is never silently ignored, but frequent
deadlocks indicate a real application-level bug:

1. **Inconsistent lock acquisition order across code paths.** Classic
   example: transaction A locks row 1 then row 2; transaction B locks row
   2 then row 1. If they interleave, each ends up waiting on the other.
2. **ORM-generated queries that lock rows in an order that depends on
   input data** (e.g. iterating a list of IDs in whatever order they
   arrived in an API request) rather than a consistent canonical order.
3. **Multiple unique/foreign-key constraint checks interleaving** across
   concurrent inserts touching overlapping keys.

## Diagnosis

Postgres logs deadlocks with full detail (the two queries and the lock
each was waiting on) when `log_lock_waits` is enabled — that log entry is
almost always sufficient to identify the two conflicting code paths
without needing to reproduce the deadlock live.

If deadlocks are suspected but not yet confirmed via logs, check for a
pattern of frequent lock waits between the same pair of tables/queries
using the query in the lock-contention runbook, run repeatedly over a
short window.

## Resolution

- **Establish and enforce a consistent lock/update order** across every
  code path that touches the same rows or tables — e.g. always update
  accounts in ascending ID order regardless of transfer direction. This is
  the fix that actually eliminates the class of bug, not just one instance
  of it.
- **Keep transactions short.** The shorter the window between acquiring a
  lock and releasing it (commit/rollback), the smaller the chance two
  transactions overlap badly enough to deadlock.
- **Add retry logic in the application** for the specific `40P01` deadlock
  SQLSTATE — since Postgres guarantees one side of a deadlock is aborted
  cleanly, a retry of that aborted transaction is safe and standard
  practice, not a workaround to be embarrassed about.
- **Consider `SELECT ... FOR UPDATE` ordering** explicitly (e.g. `ORDER BY
  id`) when a transaction needs to lock multiple rows, so the acquisition
  order is deterministic regardless of input order.

## When to escalate to a human

A rising rate of deadlocks after a recent deploy almost always traces to a
specific code change — this is a case where the fix belongs in application
code, not database configuration, and should be routed to whoever owns the
affected code path.
