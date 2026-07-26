# Runbook: Autovacuum Tuning and Bloat Prevention

## Symptoms
- Table/index bloat growing over time (physical size far exceeds logical row count)
- Query performance degrading gradually on frequently updated tables
- `pg_stat_user_tables.n_dead_tup` climbing without corresponding autovacuum runs
- Long-running autovacuum jobs blocking or slowing writes on large tables

## Common Causes
1. Default autovacuum thresholds (`autovacuum_vacuum_scale_factor` = 0.2) too coarse for large, high-churn tables — a 100M row table won't vacuum until ~20M dead tuples accumulate.
2. High UPDATE/DELETE churn rate exceeding autovacuum's ability to keep up.
3. Long-running transactions preventing vacuum from reclaiming dead tuples (vacuum can't remove rows still potentially visible to an open transaction).
4. `autovacuum_max_workers` too low relative to the number of actively-churning tables, causing a queue.

## Diagnosis Steps
1. `SELECT relname, n_dead_tup, n_live_tup, last_autovacuum, last_autovacuum FROM pg_stat_user_tables ORDER BY n_dead_tup DESC LIMIT 20;`
2. Check for long-running transactions blocking vacuum: `SELECT pid, now() - xact_start, state, query FROM pg_stat_activity WHERE xact_start IS NOT NULL ORDER BY xact_start;`
3. Check table bloat estimate (via `pgstattuple` extension or a bloat-estimation query) to confirm actual wasted space.

## Remediation
- For specific high-churn tables, set per-table autovacuum parameters rather than changing global defaults:
  `ALTER TABLE big_table SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_cost_delay = 2);`
- Ensure no application pattern leaves transactions open indefinitely (idle-in-transaction is the most common vacuum blocker).
- For severely bloated tables, a manual `VACUUM FULL` (which locks the table) or `pg_repack` (which doesn't) may be needed as a one-time remediation before ongoing autovacuum tuning takes effect.
- Monitor `autovacuum_max_workers` utilization; increase if workers are consistently saturated across many tables.

## Escalation Threshold
Dead tuple ratio (`n_dead_tup / (n_live_tup + n_dead_tup)`) exceeding 20% on a frequently-queried table warrants investigation; exceeding 40% typically shows measurable query performance degradation.
