# Runbook: WAL Growth and Disk Pressure

## Symptoms
- `pg_wal` directory (or WAL storage in managed providers) growing unexpectedly
- Disk usage alerts correlated with WAL rather than table data growth
- In severe cases, disk full errors halting the database entirely

## Common Causes
1. A replication slot that has stopped being consumed (e.g. a disconnected replica or logical replication consumer) — Postgres retains WAL indefinitely for an inactive slot, since it doesn't know when it'll resume.
2. `archive_command` failing silently, causing WAL segments to accumulate because they can't be recycled until successfully archived.
3. A very high write rate without a corresponding checkpoint/archival cadence tuned to match.
4. Large bulk operations generating WAL faster than it can be shipped/archived.

## Diagnosis Steps
1. Check for inactive replication slots: `SELECT slot_name, active, restart_lsn, pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS retained_bytes FROM pg_replication_slots;` — a large `retained_bytes` on an `active = false` slot is the most common cause of runaway WAL growth.
2. Check archiver status: `SELECT * FROM pg_stat_archiver;` — a growing `failed_count` indicates `archive_command` is failing.
3. Check current WAL disk usage directly if you have filesystem access, or via your managed provider's storage metrics.

## Remediation
- **Drop or fix stale replication slots.** If a slot belongs to a replica or consumer that's permanently gone, drop it: `SELECT pg_drop_replication_slot('slot_name');` — but confirm first that nothing legitimate still depends on it, since dropping prematurely breaks that consumer's ability to resume.
- Fix the underlying cause of `archive_command` failures (commonly: destination storage permissions, network connectivity to the archive target, or disk full on the archive destination itself).
- For bulk load operations expected to generate large WAL volume, consider `wal_compression = on` and scheduling the load during a window with archival headroom.

## Escalation Threshold
WAL directory approaching 80% of allocated disk should page on-call immediately — this can progress to a full outage (Postgres refuses writes when disk is full) faster than most other capacity issues, often within hours rather than days.
