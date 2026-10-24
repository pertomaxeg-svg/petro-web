# Actual service order reservation —0035

Existing repository/approved branch/project only;0009 deferred.

Implements real first-proof consumption, exact current quote recheck, policy/funding usage reservation and product stock hold; caller-bound receipt replay, versioned unstarted cancellation and private bounded system expiry. Public/private order tables use RLS/no direct client DML. Private helpers/expiry are SECURITY INVOKER and postgres-only; public entry points require current confirmed active caller with password gate and explicit worker scope or central read/cancel role. No service-role claim is manufactured.

A reserved order is held, never paid. Cancellation/expiry releases only unstarted holds, has no physical stock delta, and records honest human/system attribution from0034. Payment, stock issue/delivery, evidence/invoice/outbox are separate subsequent work. Snapshots preserve booked vehicle/branch/price/policy identity. Historical vehicle moves are not blocked by an order's current-branch composite FK.

The native named pg_cron job runs every minute, batch100, SKIP LOCKED/advisory guard, bounded retry/backoff and review_required after5 failures. Only error SQLSTATE is retained. Existing scheduler dependencies/client grants/job ownership are guarded; no unrelated job is overwritten. Rollback refuses retained order history, unschedules ONLY this job and retains the extension.

RED must show the absent order/reserve/cancel/expiry contract before implementation. Require full SQL/API/browser/actual Auth/native scheduler tests from the saved detailed reservation plan, no paid/captured claim in this stage, and preserving rollback/defaultACL before application.

Status: database implementation under acceptance; HTTP/UI and actual committed scheduler exercise pending. NOT applied live; no production orders or scheduler were created.
