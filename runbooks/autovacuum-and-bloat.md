# Runbook: Autovacuum Falling Behind / Table Bloat

## Symptoms

- `n_dead_tup` in `pg_stat_user_tables` climbing steadily relative to
  `n_live_tup` and not coming back down.
- Query plans that used to use an index scan shift to sequential scans, or
  index scans get noticeably slower, as the physical table grows larger
  than its logical row count would suggest.
- `pg_stat_bgwriter` shows high `buffers_backend` relative to
  `buffers_clean`/`buffers_checkpoint` — backends are doing writes that
  the background writer/checkpointer should be handling, often a symptom
  of vacuum-related I/O pressure.
- On Postgres versions/configurations without safeguards, transaction ID
  (XID) wraparound warnings in logs — a much more severe variant of the
  same underlying problem (autovacuum not keeping up).

## Likely causes

1. **High-churn tables** (frequent `UPDATE`/`DELETE`) where the default
   autovacuum thresholds (`autovacuum_vacuum_scale_factor` = 20% of table
   size by default) mean a large table waits a long time between vacuum
   runs, accumulating a lot of dead tuples in the meantime.
2. **Autovacuum starved of I/O** by `autovacuum_vacuum_cost_limit` /
   `autovacuum_vacuum_cost_delay` settings that throttle it too
   aggressively for the actual write rate.
3. **Long-running transactions preventing cleanup** — a transaction that's
   been open for a long time (see connection-pool-saturation and
   long-running-queries runbooks) prevents autovacuum from reclaiming dead
   tuples that are still potentially visible to that old transaction's
   snapshot.
4. **Too many autovacuum workers contending**, or too few for the number
   of tables needing attention (`autovacuum_max_workers`).

## Diagnosis

```sql
-- Dead tuple ratio per table
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC
LIMIT 20;

-- Is a long-running transaction blocking cleanup?
SELECT pid, now() - xact_start AS xact_age, state, query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL
ORDER BY xact_start ASC
LIMIT 10;

-- Currently-running vacuum activity
SELECT pid, now() - query_start AS running_for, query
FROM pg_stat_activity
WHERE query ILIKE '%vacuum%';
```

If `last_autovacuum` is null or very old for a high-write table, autovacuum
isn't keeping pace with that table specifically.

## Resolution

- **Tune per-table autovacuum settings** for high-churn tables rather than
  changing global defaults, e.g.:
  `ALTER TABLE <table> SET (autovacuum_vacuum_scale_factor = 0.05);`
  to trigger vacuum after 5% dead tuples instead of the 20% default.
- **Increase `autovacuum_vacuum_cost_limit`** (or reduce
  `autovacuum_vacuum_cost_delay`) if autovacuum is running but too slowly
  to keep up, and the underlying storage has headroom for the extra I/O.
- **Resolve any long-running/idle-in-transaction sessions** first (see the
  connection-pool-saturation runbook) — bloat cleanup can't proceed past
  what those old snapshots still need visible, no matter how aggressively
  autovacuum is tuned.
- **For a table already badly bloated**, a manual
  `VACUUM (VERBOSE, ANALYZE) <table>;` during a low-traffic window will
  reclaim space faster than waiting for autovacuum's normal cadence.
  `VACUUM FULL` reclaims disk space back to the OS but takes an exclusive
  lock for its duration — only use it in a maintenance window.

## When to escalate to a human

Approaching transaction ID wraparound (visible as explicit Postgres log
warnings, or `age(datfrozenxid)` climbing toward
`autovacuum_freeze_max_age`) is a severe, database-wide risk, not a
per-table performance issue — escalate immediately rather than treating it
as routine bloat.
