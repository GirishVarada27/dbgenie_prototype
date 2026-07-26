# Runbook: PostgreSQL Deadlocks

## Symptoms
- Application errors: `deadlock detected` (SQLSTATE 40P01)
- Elevated transaction rollback rate
- Intermittent, hard-to-reproduce failures under concurrent load

## Common Causes
1. Two transactions acquiring row locks on the same rows **in opposite order**.
2. Missing consistent lock ordering convention across application code paths.
3. Long transactions holding locks while waiting on application-level logic (e.g. an external API call inside a DB transaction).
4. Foreign key constraint checks acquiring locks on referenced rows unexpectedly.

## Diagnosis Steps
1. Postgres logs the full deadlock detail when `log_lock_waits = on` — check for the deadlock graph in logs, showing both transactions' queries and lock modes.
2. Identify the two (or more) conflicting queries and the tables/rows involved.
3. Check application code for the order in which rows/tables are touched in each code path — deadlocks are almost always an ordering mismatch.

## Remediation
- Establish and enforce a consistent lock acquisition order across all application code (e.g. always update `accounts` before `transactions`, never the reverse).
- Keep transactions as short as possible — never hold a DB transaction open across a network call to another service.
- Consider `SELECT ... FOR UPDATE` explicitly and in a consistent order when a transaction needs to touch multiple rows that could be contended.
- For high-contention hot rows, consider advisory locks (`pg_advisory_xact_lock`) to serialize access explicitly rather than relying on implicit row locking.

## Note on Severity
A deadlock is not itself a bug that loses data — Postgres always resolves it by aborting one transaction, which the application should retry. Frequent deadlocks are a performance/contention problem worth fixing, but isolated occurrences under retry logic are generally not an emergency.
