# Runbook: Index Bloat

## Symptoms
- Index size growing disproportionately to table size
- Index scans slower than expected despite an index being present
- Increased buffer cache pressure from oversized indexes

## Common Causes
1. High UPDATE churn on indexed columns — each update to an indexed column typically creates a new index entry, and the old one becomes dead space until vacuumed.
2. Autovacuum not keeping up (see Runbook: Autovacuum Tuning) — index bloat and table bloat are closely related.
3. Sequential/monotonically increasing indexed values (e.g. a bigserial primary key with frequent deletes from the middle of the range) causing uneven B-tree page utilization.

## Diagnosis Steps
1. Compare index size to a fresh-rebuild baseline. There is no single built-in bloat percentage view in vanilla Postgres — use the `pgstattuple` extension: `SELECT * FROM pgstatindex('index_name');` and check `avg_leaf_density` — healthy is typically 80-90%, bloated indexes often show 50% or lower.
2. Check `pg_stat_user_indexes` for scan counts to confirm the index is actually used before spending effort optimizing it (an unused bloated index should simply be dropped).
3. Correlate with table dead-tuple ratio from the autovacuum runbook — they often bloat together.

## Remediation
- `REINDEX CONCURRENTLY` rebuilds the index without holding a long exclusive lock (available Postgres 12+), safe to run on a live production table.
- For indexes on monotonically increasing columns with heavy deletes, consider `REINDEX` on a regular schedule rather than relying solely on autovacuum, since B-tree page-level bloat isn't fully reclaimed by vacuum alone.
- Drop unused indexes entirely (confirmed via zero or near-zero `idx_scan` over a representative time window) rather than maintaining bloat-prone structures with no query benefit.

## Escalation Threshold
Index bloat is rarely an emergency on its own — treat as a scheduled maintenance item unless it's directly correlated with a specific slow-query incident, in which case prioritize `REINDEX CONCURRENTLY` on that specific index.
