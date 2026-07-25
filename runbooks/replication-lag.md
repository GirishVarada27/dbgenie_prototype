# Runbook: Replication Lag

## Symptoms

- Read replicas return stale data — a row written on the primary doesn't
  show up on a replica for seconds or minutes.
- `pg_stat_replication` on the primary shows a growing gap between
  `sent_lsn` and `replay_lsn` (or `write_lag`/`flush_lag`/`replay_lag`
  intervals growing) for one or more standbys.
- On managed platforms (Neon, RDS, etc.), the platform's own replica-lag
  metric climbs steadily instead of staying near zero.

## Likely causes

1. **Replica under-provisioned relative to primary write volume** — the
   standby's I/O or CPU can't keep up with applying the WAL stream fast
   enough.
2. **A long-running query on the replica** (Postgres will delay applying
   conflicting WAL records until the query finishes, to avoid canceling it,
   when `hot_standby_feedback`/`max_standby_streaming_delay` are configured
   to prioritize query completion over lag).
3. **Network throughput/latency** between primary and replica, especially
   across regions.
4. **A burst of high write volume on the primary** (bulk load, large
   batch job) that temporarily outpaces normal replication throughput —
   often self-resolving once the burst ends.
5. **Vacuum or checkpoint I/O contention** on the replica competing with
   WAL replay for disk bandwidth.

## Diagnosis

Run on the **primary**:

```sql
SELECT client_addr, state, sent_lsn, write_lsn, flush_lsn, replay_lsn,
       write_lag, flush_lag, replay_lag
FROM pg_stat_replication;
```

Run on the **replica**, if directly accessible:

```sql
SELECT now() - pg_last_xact_replay_timestamp() AS replica_lag;

-- Is a query currently delaying WAL replay?
SELECT pid, now() - query_start AS running_for, query
FROM pg_stat_activity
WHERE state = 'active';
```

A steadily growing `replay_lag` under stable write load points to a
throughput problem on the replica; a lag that tracks a specific long query
on the replica points to standby query conflict handling instead.

## Resolution

- **If caused by a long replica-side query**: this is a tradeoff Postgres
  is making deliberately (finish the query vs. apply WAL immediately).
  Either shorten/optimize the offending query, or reduce
  `max_standby_streaming_delay` to bound how long replay will wait, at the
  cost of that query potentially being canceled instead.
- **If caused by sustained throughput mismatch**: scale up the replica's
  compute/IOPS, or reduce primary write volume by batching bulk
  operations during off-peak windows.
- **If caused by a one-off bulk load burst**: usually self-resolves; confirm
  lag is trending back down rather than continuing to grow before treating
  it as resolved.
- **If network-related**: check cross-region/cross-AZ latency between
  primary and replica; consider relocating the replica closer to the
  primary if lag correlates with network metrics rather than load.

## When to escalate to a human

Sustained, non-recovering replication lag on a replica serving
read-after-write-sensitive traffic (e.g. showing a user their own just-made
change) can produce visible application bugs, not just a monitoring
nuisance — treat non-recovering lag as higher priority than a query that's
merely slow.
