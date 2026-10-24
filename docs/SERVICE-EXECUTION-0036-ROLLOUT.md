#0036 execution/evidence/delivery rollout

Only approved repo/branch and project.0035 live;0009 deferred.
RED91c544e / Actions40112966339 acceptance120928350440 must fail for missing actual execution/evidence. This stage adds actual scoped start, private order-specific evidence (Storage metadata checked), rules frozen at start, immutable delivery and actual partial product stock issue. Financial authorization stays held; final driver code/capture/merchant receivable/invoice is the next dependency. No paid or whole-project completion claim.

Existing generic vehicle document authorization is not broadened. New private registry and INSERT/SELECT Storage policies accept only own current authorized order intents. No UPDATE/DELETE policy, no overwrite, accepted evidence immutable. Fuel/oil meter image+reading, wash before/after, serial image/number when explicitly required. No invented invoice VAT or business price.
Actual quantities cannot exceed booked amount/quantity; lower quantities compute from booked unit price, release unused physical stock and keep original financial hold for later tested partial capture. Delivered/started work never auto-cancels as a draft. Identity/odometer changes lead review_required, never fabricated payment or restock.

Require SQL/API/browser/real Auth/Storage tests and preserving rollback. Rollback refuses retained executions/evidence/deliveries/custom rules; never delete production history to downgrade. Source/rollback fingerprints to be pinned after final SQL passes; no live application yet. Existing27 defaultACL scopes include3 managed cron-to-postgres defaults; preserve them.
