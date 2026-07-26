# Runbook: Connection Pool Exhaustion

## Symptoms
- Application errors: "too many clients already" or connection timeout errors
- `pg_stat_activity` count approaching `max_connections`
- New connection attempts hanging or failing under load spikes

## Common Causes
1. Application not using a connection pooler (or pool sized too large relative to `max_connections`).
2. Connection leaks — application code acquiring a connection and not releasing it (e.g. missing `finally` block, error path skipping release).
3. Traffic spike exceeding the provisioned pool/connection capacity.
4. Multiple application instances each opening their own large pool, cumulatively exceeding the database's `max_connections`.
5. Long-running queries or idle-in-transaction sessions holding connections unnecessarily.

## Diagnosis Steps
1. `SELECT count(*), state FROM pg_stat_activity GROUP BY state;` — high `idle in transaction` count usually indicates a leak, not real load.
2. `SELECT pid, now() - state_change AS idle_duration, query FROM pg_stat_activity WHERE state = 'idle in transaction' ORDER BY idle_duration DESC;`
3. Check application-side pool configuration (max pool size × number of app instances vs. database `max_connections`).
4. Review recent deploys for changes to connection handling code.

## Remediation
- Introduce or reconfigure a connection pooler (e.g. PgBouncer, or Neon's built-in pooled connection string) sitting between the application and Postgres, using transaction-mode pooling for most workloads.
- Set `idle_in_transaction_session_timeout` to automatically terminate abandoned idle-in-transaction sessions.
- Audit application code for connection leak patterns — ensure every acquired connection/client is released in a `finally` block regardless of success or error.
- Right-size per-instance pool limits: (max_connections - reserved_superuser_connections) / number_of_app_instances, with headroom for background workers.

## Escalation Threshold
Active connections sustained above 80% of `max_connections` should trigger a warning; above 95% should page on-call, as new connections will start failing imminently.
