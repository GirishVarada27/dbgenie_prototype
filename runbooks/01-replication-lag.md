# Runbook: PostgreSQL Replication Lag

## Symptoms
- `pg_stat_replication.replay_lag` or `flush_lag` growing over time
- Read replicas serving stale data
- Application errors from read-after-write inconsistency on replica reads

## Common Causes
1. **Long-running query on the replica** blocking WAL replay (`hot_standby_feedback` interactions).
2. **Network throughput** between primary and replica insufficient for WAL volume.
3. **Replica under-provisioned** (CPU/IO) relative to primary's write rate.
4. **Large single transaction** on primary (bulk load, mass update) producing a WAL burst.
5. **max_standby_streaming_delay** too low, causing frequent replay cancellations and retries.

## Diagnosis Steps
1. On primary: `SELECT client_addr, state, sent_lsn, replay_lsn, replay_lag FROM pg_stat_replication;`
2. On replica: `SELECT now() - pg_last_xact_replay_timestamp() AS replication_delay;`
3. Check replica for long-running queries holding back replay: `SELECT pid, now() - query_start, query FROM pg_stat_activity WHERE state != 'idle';`
4. Check WAL generation rate on primary during the lag window (correlate with application deploy/batch job timing).

## Remediation
- If a specific replica query is the cause, consider setting `max_standby_streaming_delay` appropriately or moving that workload off the lagging replica.
- Scale up replica IOPS/CPU if consistently lagging under normal load.
- For bulk load operations, consider running them during low-traffic windows or splitting into smaller transactions to reduce WAL burst size.
- If network-bound, check `wal_compression = on` to reduce WAL volume shipped.

## Escalation Threshold
Lag exceeding 60 seconds sustained for 5+ minutes should page on-call; lag exceeding 10 minutes risks stale reads breaching most application SLAs.
