# Runbook: Disk Space Exhaustion

## Symptoms
- Write queries failing with "could not extend file" or "no space left on device"
- Database refusing new connections or becoming read-only in some managed environments
- This is one of the few Postgres failure modes that can cause a full outage rather than degraded performance

## Common Causes
1. Organic table/index growth outpacing provisioned storage.
2. Runaway WAL growth (see Runbook: WAL Growth) — often the actual root cause behind an apparent "disk full" event, rather than table data itself.
3. Table/index bloat (see relevant runbooks) inflating storage usage well beyond logical data size.
4. Temporary files from large sort/hash operations (`work_mem` exceeded) accumulating during a burst of expensive queries.
5. Orphaned large objects or unlogged tables left over from a past migration or feature that's no longer cleaned up.

## Diagnosis Steps
1. Break down disk usage by category first — don't assume it's table growth: check WAL size, temp file usage (`pg_stat_database.temp_bytes`), and actual table/index sizes separately.
2. `SELECT pg_size_pretty(pg_database_size(current_database()));` for a database-level view, then drill into `pg_total_relation_size()` per table to find the largest contributors.
3. Check for the replication-slot WAL retention issue specifically, since it's a common and non-obvious cause (see WAL Growth runbook diagnosis steps).

## Remediation
- **Immediate relief:** if WAL retention from a stale replication slot is the cause, dropping the stale slot (after confirming it's safe) frees space immediately — often the fastest path back to a writable state.
- **Immediate relief:** identify and drop/truncate any clearly obsolete large tables if applicable.
- **Structural fix:** provision additional storage (most managed providers, including Neon, support online storage scaling without downtime).
- **Structural fix:** address bloat and WAL retention issues as ongoing maintenance so this doesn't recur.
- For temp-file-driven spikes, consider tuning `work_mem` carefully (too high risks memory pressure instead) or optimizing the specific queries generating large sorts/hashes.

## Escalation Threshold
This is always a page-immediately incident once disk usage exceeds ~90% of capacity — the failure mode (complete write outage) arrives with little warning once the threshold is crossed, so early warning at 80% should already be actioned, not just monitored.
