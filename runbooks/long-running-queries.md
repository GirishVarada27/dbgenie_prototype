# Runbook: Long-Running Queries

## Symptoms

- A query has been in `state = 'active'` in `pg_stat_activity` for more
  than 60 seconds (DBGenie's default long-query threshold).
- Application requests time out or the app-level connection pool empties
  out because connections are stuck waiting on this query.
- Other queries against the same tables start blocking (see the
  lock-contention runbook) if the long query holds row or table locks.

## Likely causes

1. **Missing or unused index.** A sequential scan on a large table where an
   index on the filtered/joined column would let Postgres skip most rows.
2. **A query that returns or joins far more rows than intended** — e.g. a
   missing `WHERE` clause, an accidental cross join, or a `LIKE '%x%'`
   pattern that can't use a standard b-tree index.
3. **`pg_sleep()` or an external call inside a transaction** — for example
   a query that waits on a slow external API call while holding a
   transaction open. This is functionally identical to a slow query from
   Postgres's point of view.
4. **Lock wait, not actual work.** A query that's fast to execute but stuck
   waiting to acquire a lock held by another session appears identical to
   a genuinely slow query in `pg_stat_activity` unless you check `wait_event`.

## Diagnosis

```sql
-- Find long-running active queries and how long they've been running
SELECT pid, now() - query_start AS running_for, state, wait_event_type,
       wait_event, query
FROM pg_stat_activity
WHERE state = 'active' AND pid <> pg_backend_pid()
ORDER BY query_start ASC;
```

If `wait_event_type` is `Lock`, the query itself isn't slow — it's blocked.
Follow the lock-contention runbook instead.

If `wait_event_type` is null and the query is genuinely executing, get its
plan:

```sql
EXPLAIN (ANALYZE, BUFFERS) <the query>;
```

Look for `Seq Scan` on large tables, large `Rows Removed by Filter` counts,
and any step whose actual time is wildly out of proportion to the rest of
the plan.

## Resolution

- **Add a targeted index** on the column(s) used in the query's `WHERE`,
  `JOIN`, or `ORDER BY` clauses, once `EXPLAIN ANALYZE` confirms a
  sequential scan is the bottleneck. Verify with `EXPLAIN` again before
  and after — don't guess.
- **Rewrite the query** to filter earlier (push predicates down), avoid
  unnecessary joins, or paginate instead of fetching an unbounded result
  set.
- **Set a `statement_timeout`** for the application role (or per-session)
  so a runaway query is killed automatically rather than holding resources
  indefinitely: `SET statement_timeout = '30s';`.
- **If it's actively causing an incident right now**, and it's safe to do
  so (i.e. not a legitimate long-running batch job), terminate it:
  `SELECT pg_cancel_backend(pid);` (graceful) or
  `SELECT pg_terminate_backend(pid);` (forceful) using the PID from the
  diagnosis query above.

## When to escalate to a human

If the query is a known, intentional long-running batch/report job, this
may be a false positive rather than an incident — confirm against the
`application_name` or query text before taking any corrective action.
