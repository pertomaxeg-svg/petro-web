# Card-request fulfillment filters — 0029

Target: Supabase `msvgzsfzrqlrfpstthhe` only. 0009 deferred.

Source SHA-256: `391b0cbcca4b714fb6a217a70075fa15ac7ff1f01c15b64c1dc128bad940e15a`.
Rollback SHA-256: `e3faf1694532712197b45f7977b00215ac45486fb08a746a2f81bd1768457282`.

Adds installation/pickup request filtering to the existing shared card catalog. The filter is applied before totals and pagination. Unknown methods and method filters on other views are rejected. Existing authorization, shared request identity, issuance/collection statuses, stock and history remain intact. No grants, business rows, price or status transitions change. These tabs classify requests; they do not prove delivery, installation, fee collection or field NFC operation.

UI: all requests / installation / branch pickup tabs; method visible in each request row; pickup details omit unnecessary coordination contact fields. No new request store.

TDD RED: run 39979242429, job 120501871977, commit 3a7e8d6 returned the pickup fixture under the installation filter. Require GREEN SQL/API/browser filter tests and exact function/ACL rollback before applying live.
Orval generated the OpenAPI changes on GitHub in run 40062359553, job 120778402571; the exact generated contract patch is copied into the repository while preserving unrelated custom client behavior.

Preflight baseline: live 0028; cards catalog MD5 `bd041ff8a089cced5cc5a6370e34333d`; ACL `{postgres=X/postgres,authenticated=X/postgres}`; default ACL 24 scopes/hash `c70fd3da5a6b0c24f1ac2bac5657bcb3`; legacy status MD5 `d6a0defdb1102d00b0743723db453bad`. Recheck immediately before application and compare after. Forward guards and rollback require the reviewed definition and unique anchors.

Status: applied alone on 24 October 2026, ledger version `20261024043222`.
GREEN commit `5b5e1329b765587a39e973fae3ec2f50550039e1`: GitHub run 40062548670, acceptance job 120778995862 passed types, unit/build, full isolated SQL/API/browser checks, installation/pickup row separation, invalid/inapplicable API rejection, pagination and exact function/default-ACL rollback. The actual isolated Auth/PostgREST/Storage checks and service cleanup also passed in job 120778996081.
Regeneration run 40062548665 found zero drift in the generated contracts.
Fresh preflight matched live 0028, source SHA and all reviewed fingerprints. Postflight cards catalog MD5 `a819fa4e6f8dff44ff29777f9319c8b2`; fulfillment guard present; catalog ACL/default ACL/legacy definition unchanged. No live business fixtures, prices, credentials or status transitions were written.
This activates the database contract. It does not publish a web/API release, prove physical NFC delivery/installation, or close project-wide acceptance.
