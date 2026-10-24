# Honest system execution attribution —0034

Existing project/repository/approved branch only;0009 deferred.

Prerequisite for future scheduled expiry of unstarted service orders. No scheduler, reservation command, financial charge, stock issue, synthetic Auth account or fabricated JWT/session claim is added here.

Add explicit optional system-attribution fields to financial hold closure, inventory reservation completion and immutable inventory movements. Human executor behavior and existing actor FKs remain intact. The only initial system code is service_order_expiry: it can mark a released fleet_usage hold and release reserved stock, with no human actor, but cannot mark captured/consumed funds or physical stock issue/restock. Unknown/both/missing executors are rejected for financial closure and immutable inventory movements, including SQL NULL/UNKNOWN cases. Existing nullable inventory-completion behavior is preserved when no new system marker is supplied; an explicit system completion must be a released reservation with no human completer. The future job must set completion and movement markers atomically. Existing inventory history displays النظام and actorKind=system, with no fake human profile.

No new table/function grants, exposed mutation input or user-facing required field. Private/client DML restrictions, RLS, immutable movement trigger, legacy human finance/inventory release and capture behavior are retained. The previous inventory-query function is replaced in place with one exact verified actor-label fragment; ACL/search_path and all unrelated logic are preserved.

RED:40086234555 / acceptance120849728705, absent attribution fields. Require GREEN scoped SQL human/system exclusivity, missing actor/unknown actor/consumption rejection, honest read history, immutability and direct-client denial, legacy full SQL/API/browser and actual Auth/Storage checks, persisted-attribution rollback refusal and exact schema/defaultACL restoration. No live synthetic fixture.

Rollback refuses ANY persisted system-attributed record. Disposable CI normalizes only its exact test fixture to exercise an empty-attribution downgrade; never perform that normalization on live records. Live recovery with system history requires a preserving forward fix.

Source SHA-256: `f18e518132e314825d078e9b93547b53938a4c2656da3647ad2c9822ce8da247`.
Rollback SHA-256: `462b17c1114f72bd5c662f4e517566b640374f56dd03c027a5443e127689419a`.

Final GREEN: commit5943a5a34719ec6d80b841ccdf466be30e6c8c2d, run40086727666, acceptance120851082458 and real-auth-storage120851082523. Truthful history, executor constraints, immutable stock history, role denial, legacy full SQL/API/browser/Auth/Storage behavior and preserving rollback passed. Contracts40086727678 have no drift. No live inventory reservations or unattributed inventory completions existed at preflight; no historical executor is inferred or rewritten.

Status: accepted and allowlisted, pending live activation. Order reservation/execution/actual automated expiry and payment remain unfinished.
