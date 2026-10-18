# Runbook: Bull Queue Redis Outage

**Severity:** SEV-2 (asynchronous audit and email work degraded)  
**Owner:** Backend on-call

---

## Summary

Bull queues use Redis for asynchronous email delivery, audit writes, and
portfolio link verification. Redis connection failures do not fail API
requests. Enqueue attempts are bounded to two seconds; an enqueue error or
timeout is logged and counted in `bull_queue_enqueue_failures_total`, and the
caller continues without a queued job.

Audit jobs are best-effort: audit records that fail to enqueue are lost, and
must be identified from application logs or related business events if an
incident requires reconstruction. Email notification records are written to
PostgreSQL before Bull enqueue. A Redis outage therefore leaves those records
pending in `notification_queue`; email delivery is delayed until the normal
notification recovery/reprocessing path can enqueue them. Link verification
jobs also follow best-effort enqueue behavior and may need to be rescheduled.

Bull/ioredis reconnects automatically. The `bull_queue_redis_connected` gauge
is `0` during connection errors and returns to `1` after Bull emits `ready`.

## Symptoms and detection

- `bull_queue_enqueue_failures_total` is increasing, labeled by queue name.
- `bull_queue_redis_connected` is `0` for one or more queues.
- Audit rows stop appearing; email notifications remain pending or arrive late.
- Bull queue logs include `queue_redis_connection` or `queue_enqueue` operations.

Check `GET /metrics` and the backend logs. Confirm the configured `REDIS_URL`,
or `REDIS_HOST`/`REDIS_PORT`, and verify Redis availability from the backend
runtime.

## Impact and mitigation

| Work | Impact while Redis is unavailable |
| ---- | --------------------------------- |
| API requests | Continue; audit/email enqueue failures are non-fatal. |
| Audit writes | Best-effort and may be lost if they cannot be queued. |
| Email notifications | Persisted rows remain pending; delivery is delayed. |
| Link verification | Jobs may be lost and need rescheduling. |

1. Restore Redis connectivity; do not repeatedly restart the API just to retry
   enqueue operations.
2. Watch the Redis connection gauge return to `1` and ensure the failure
   counter stops increasing.
3. Confirm pending notification rows are being reprocessed and email delivery
   resumes.
4. Assess the outage window for audit events that require manual reconstruction
   and reschedule any missed link verifications.

## Recovery

Once Redis is healthy, Bull reconnects and subsequent enqueue attempts resume
normally. Verify queue workers are processing jobs, inspect notification
backlog and failure logs, then record the outage duration and any known lost
best-effort work.
