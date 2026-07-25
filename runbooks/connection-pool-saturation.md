# Runbook: Connection Pool Saturation

## Symptoms

- `active_connections` is at or above 80% of `max_connections`.
- New client connections start failing with `FATAL: too many connections
  for role` or `FATAL: remaining connection slots are reserved`.
- Application-side connection pool (pgbouncer, Prisma, node-postgres Pool,
  etc.) reports timeouts acquiring a connection from the pool.
- `pg_stat_activity` shows many rows with `state = 'idle in transaction'`
  or `state = 'idle'` rather than `active` — connections are being held
  open without doing work.

## Likely causes

1. **Connection leak in the application.** Code paths that acquire a
   client/connection but never release it back to the pool (missing
   `client.release()`, an unhandled exception before a `finally` block, a
   transaction that's never committed or rolled back).
2. **Pool size misconfigured too high relative to `max_connections`.** If
   there are N application instances each with a pool of size M, and
   N * M approaches or exceeds `max_connections`, saturation is expected
   under normal load, not a bug.
3. **No connection pooler (e.g. PgBouncer) in front of Postgres**, so every
   application replica opens its own direct pool against the database
   instead of sharing a small number of pooled backend connections.
4. **Long-running transactions holding connections** — see the
   long-running-queries runbook; a query or transaction that never
   completes ties up a connection for its entire duration.

## Diagnosis

```sql
-- Breakdown of connection states
SELECT state, count(*) FROM pg_stat_activity
WHERE pid <> pg_backend_pid() GROUP BY state;

-- Longest-idle "idle in transaction" sessions (often the real leak)
SELECT pid, usename, application_name, state,
       now() - state_change AS idle_for, query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
ORDER BY state_change ASC;

-- Current vs. max
SHOW max_connections;
```

If most connections are `idle in transaction` and have been for minutes,
that's a strong signal of an application-level leak or an abandoned
transaction, not legitimate load.

## Resolution

- **Immediate relief**: terminate the oldest idle-in-transaction sessions
  with `SELECT pg_terminate_backend(pid)` for the specific PIDs identified
  above — only after confirming they're not mid-way through legitimate
  long work.
- **Short term**: reduce application connection pool size per instance, or
  scale down the number of application replicas temporarily.
- **Structural fix**: introduce PgBouncer (or equivalent) in transaction
  pooling mode between the application and Postgres so hundreds of
  application-level connections multiplex onto a small number of real
  backend connections.
- **Code fix**: audit any code path that acquires a client outside of a
  try/finally (or equivalent) block, and add statement timeouts
  (`statement_timeout`) plus idle-in-transaction timeouts
  (`idle_in_transaction_session_timeout`) as a backstop so a stuck
  transaction can't hold a connection indefinitely.

## When to escalate to a human

If `idle in transaction` sessions are tied to a specific recent deploy,
this is very likely a regression in that deploy and should be rolled back
rather than worked around at the database layer.
