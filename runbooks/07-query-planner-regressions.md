# Runbook: Query Planner Regressions

## Symptoms
- A previously fast query suddenly becomes slow with no application code change
- `EXPLAIN` shows a different plan shape than historically observed (e.g. sequential scan replacing an index scan)
- Performance degrades gradually as a table grows, then drops off a cliff at some threshold

## Common Causes
1. **Stale statistics** — `ANALYZE` hasn't run recently enough for the planner's row-count estimates to reflect actual data distribution, especially after a bulk load or large delete.
2. **Data distribution shift** — the query planner's cost-based decisions (e.g. index scan vs. sequential scan) flip once table size or value distribution crosses a threshold relative to `random_page_cost`/`seq_page_cost` settings.
3. A parameter value in a prepared statement causing a generic plan to be used instead of a custom plan optimized for that specific value (relevant after the 5th execution of a prepared statement, per Postgres's plan caching behavior).
4. Missing or outdated extended statistics for correlated columns, causing the planner to misestimate selectivity on multi-column filters.

## Diagnosis Steps
1. Run `EXPLAIN (ANALYZE, BUFFERS)` on the slow query and compare estimated vs. actual row counts at each plan node — large discrepancies point directly to stale statistics.
2. Check `pg_stat_user_tables.last_analyze` / `last_autoanalyze` for the tables involved.
3. If using prepared statements, test with `PREPARE`/`EXECUTE` directly to see if a generic plan is being chosen; compare against a fresh, non-prepared execution.

## Remediation
- Run `ANALYZE table_name;` immediately if statistics are stale — this is low-risk and often resolves the issue in minutes.
- For tables with frequent bulk changes, increase `autovacuum_analyze_scale_factor` sensitivity (lower the threshold) so ANALYZE runs more proactively.
- For correlated multi-column filters, consider `CREATE STATISTICS` (extended statistics, Postgres 10+) to help the planner estimate joint selectivity correctly.
- If a specific prepared statement is choosing a poor generic plan, consider `SET plan_cache_mode = force_custom_plan;` for that session/query as a targeted fix.

## Note
This is the single most common cause of "it was fast yesterday, it's slow today with no code change" incidents — always check statistics freshness before assuming a structural fix (new index, query rewrite) is needed.
