# Runbook: Low Buffer Cache Hit Ratio / High Disk I/O

## Symptoms

- `pg_stat_database` shows `blks_read` (disk reads) growing much faster
  relative to `blks_hit` (shared buffer cache hits) than the historical
  baseline — the cache hit ratio is dropping.
- Query latency increases across the board without any single query
  obviously misbehaving in `EXPLAIN`.
- Elevated disk I/O / IOPS on the underlying storage, visible in platform
  metrics (Neon, RDS, etc.) even when query volume hasn't changed much.

## Likely causes

1. **Working set larger than `shared_buffers`.** The set of pages actively
   being read/written no longer fits in memory, so Postgres has to go to
   disk (or the OS page cache, which is slower than shared buffers) more
   often.
2. **A new query pattern or report scanning a large fraction of a big
   table**, evicting frequently-used pages from the cache in the process
   (cache pollution from a single expensive query).
3. **Table/index bloat** — dead tuples from updates/deletes that haven't
   been reclaimed by autovacuum mean the same logical data now occupies
   more physical pages, so the effective cache hit ratio for a given
   `shared_buffers` size drops even though the actual data volume didn't
   grow much.
4. **Instance resized down** (fewer resources) without a corresponding
   reduction in data/working-set size.

## Diagnosis

```sql
-- Overall hit ratio for the current database
SELECT sum(blks_hit) AS hits, sum(blks_read) AS reads,
       round(100.0 * sum(blks_hit) / NULLIF(sum(blks_hit) + sum(blks_read), 0), 2) AS hit_ratio_pct
FROM pg_stat_database
WHERE datname = current_database();

-- Per-table hit ratio, to find the worst offenders
SELECT relname,
       heap_blks_hit, heap_blks_read,
       round(100.0 * heap_blks_hit / NULLIF(heap_blks_hit + heap_blks_read, 0), 2) AS hit_ratio_pct
FROM pg_statio_user_tables
ORDER BY heap_blks_read DESC
LIMIT 20;

-- Bloat signal: dead vs. live tuples
SELECT relname, n_live_tup, n_dead_tup,
       round(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2) AS dead_pct
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 20;
```

A healthy OLTP workload's overall hit ratio is typically well above 99%;
anything trending down into the 90s or lower is worth investigating.

## Resolution

- **If bloat is the cause**: run `VACUUM (VERBOSE, ANALYZE)` on the
  affected tables during a low-traffic window, and check whether
  autovacuum settings (`autovacuum_vacuum_scale_factor`,
  `autovacuum_vacuum_cost_limit`) are keeping up with the table's write
  rate — they may need tuning for high-churn tables.
- **If a single new query/report is polluting the cache**: consider running
  it against a read replica instead of the primary, or scheduling it for
  off-peak hours.
- **If the working set has genuinely outgrown available memory**: this is
  a capacity/sizing issue — increasing `shared_buffers` (bounded by
  available instance memory) or moving to a larger instance size are the
  structural fixes, not a query-level one.
- **Add missing indexes** where sequential scans are reading far more pages
  than an index scan would need — fewer pages read per query reduces
  pressure on the cache for everything else.

## When to escalate to a human

A sudden drop in hit ratio that correlates with a specific deploy or new
feature (rather than gradual organic growth) is more likely a regression
worth reverting than something to tune the database around.
