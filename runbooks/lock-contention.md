# Runbook: Lock Contention and Blocking Queries

## Symptoms

- `pg_locks.count` is elevated compared to baseline.
- Multiple sessions in `pg_stat_activity` show `wait_event_type = 'Lock'`.
- Queries that are normally fast suddenly appear as "long-running" even
  though their actual execution time (once unblocked) is short — they're
  spending most of their time waiting, not working.
- Application error logs show statement or lock timeout errors.

## Likely causes

1. **A single long-running transaction holding a row or table lock** that
   many other transactions need — e.g. an `UPDATE` or `DELETE` inside a
   transaction that hasn't committed yet, or a `SELECT ... FOR UPDATE`
   left open.
2. **Lock escalation from an unindexed `UPDATE`/`DELETE` WHERE clause** —
   Postgres has to lock more rows than intended because it can't use an
   index to find exactly the target rows.
3. **DDL against a hot table** (`ALTER TABLE`, `CREATE INDEX` without
   `CONCURRENTLY`) taking an `ACCESS EXCLUSIVE` lock that blocks all reads
   and writes to that table until it completes.
4. **Deadlocks** — two transactions each holding a lock the other needs.
   Postgres detects and resolves true deadlocks automatically (one
   transaction is killed with a `deadlock detected` error), but frequent
   deadlocks indicate an application-level ordering problem.

## Diagnosis

```sql
-- Who is blocking whom
SELECT blocked.pid AS blocked_pid, blocked.query AS blocked_query,
       blocking.pid AS blocking_pid, blocking.query AS blocking_query,
       now() - blocking.query_start AS blocking_duration
FROM pg_locks blocked_locks
JOIN pg_stat_activity blocked ON blocked_locks.pid = blocked.pid
JOIN pg_locks blocking_locks
  ON blocking_locks.locktype = blocked_locks.locktype
 AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
 AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
 AND blocking_locks.pid != blocked_locks.pid
JOIN pg_stat_activity blocking ON blocking_locks.pid = blocking.pid
WHERE NOT blocked_locks.granted;
```

The `blocking_pid` / `blocking_query` columns identify the session actually
holding things up — that's usually the one to act on, not the blocked
sessions.

## Resolution

- **Identify the root blocker** (the session at the head of the blocking
  chain, not every session waiting on it) using the query above.
- If the blocking transaction is stuck or abandoned, terminate it:
  `SELECT pg_terminate_backend(<blocking_pid>);` — this immediately
  releases its locks and unblocks everything waiting behind it.
- **For DDL-caused blocking**, prefer `CREATE INDEX CONCURRENTLY` and
  `ALTER TABLE ... ADD COLUMN ... DEFAULT NULL` style changes (which don't
  rewrite the table) over operations that take `ACCESS EXCLUSIVE` locks
  during business hours.
- **For unindexed UPDATE/DELETE locking too many rows**, add an index on
  the WHERE clause column(s) so Postgres locks only the intended rows.
- **For recurring deadlocks**, ensure the application always acquires locks
  on multiple rows/tables in a consistent order across all code paths —
  inconsistent lock ordering is the near-universal cause of deadlocks.

## When to escalate to a human

Terminating a blocking session that turns out to be a legitimate
in-progress write can cause partial/inconsistent application state if the
application doesn't handle the resulting error gracefully — if it's not
clear the blocking transaction is safe to kill, escalate rather than guess.
