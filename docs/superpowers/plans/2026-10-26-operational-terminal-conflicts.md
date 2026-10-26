# Operational terminal conflicts — migration 0040

## Problem and scope

Native real-JWT concurrent consumption of one operational proof currently has one winner, but its losing request uses deliberate SQLSTATE40001. Earlier broad tests accepted any losing error, masking a gateway504 after about60seconds. Domain stale-version and already-used-proof conflicts are permanent for that command; they must return PT409 / HTTP409 promptly. Genuine database serialization errors remain unchanged.

## Implementation

- Target exactly five existing function definitions: worker reserve, private cancellation core, start, deliver and final payment. Replace only their single deliberate40001 withPT409; preserve every role/scope/active-account/actor-key/identity/PIN/stock/money/immutable-history guard.
- Create an additive function-only migration and symmetric rollback using exact current reviewed definitions. Check source function fingerprints before replacement and new fingerprints before rollback; fail on drift. Existing functions keep OIDs, signatures, grants, owners, SECURITY mode and empty search paths. No defaultACL, ledger, stock, user or business-data changes.
- API service-order router and disposable HTTP adapter already mapPT409 to409 after0039. Do not rewrite unrelated legacy/account-status/finance helpers or alter0009.
- Add strict native proof-race error code/message/status and bounded latency tests FIRST. Also test stale start/deliver/payment/cancel via actual JWT, same-key replay and changed-payload behavior. Update SQL tests to recognize their exact terminal domain conflicts at both pre/post migration boundaries, never arbitrary failures.
- Main gate: apply0040 after0039, compare defaultACL, run existing SQL/API/browser suite, preserve financial-history refusal, restore full disposable pre-monetary cluster, rollback0040 and compare exact schema/defaultACL before0039 rollback chain.
- Native gate: apply0040 in actual isolated Supabase; prove one proof winner + one prompt409, last-stock winner, no duplicate financial/stock effects, Auth/Storage/RLS and revocation regressions.
- Apply only a fully green pinned fingerprint to msvgzsfzrqlrfpstthhe. Targeted before/after hashes and ACL/owner snapshots, unchanged defaultACL and business counts; no live synthetic conflict/booking/payment tests.

## Status

RED native assertion added; correction not yet implemented or live. Latest accepted UI/source965cfd2462b8c410c3b23e657863550f6a4a9743 / full Actions40362693609 GREEN (121712053149,121712053792). Monetary0039 remains live20261026163457. Runtime is not deployed.
