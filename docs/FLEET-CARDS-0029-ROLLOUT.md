# Card-request fulfillment filters — 0029

Target: Supabase `msvgzsfzrqlrfpstthhe` only. 0009 deferred.

Source SHA-256: `391b0cbcca4b714fb6a217a70075fa15ac7ff1f01c15b64c1dc128bad940e15a`.
Rollback SHA-256: `e3faf1694532712197b45f7977b00215ac45486fb08a746a2f81bd1768457282`.

Adds installation/pickup request filtering to the existing shared card catalog. The filter is applied before totals and pagination. Unknown methods and method filters on other views are rejected. Existing authorization, shared request identity, issuance/collection statuses, stock and history remain intact. No grants, business rows, price or status transitions change. These tabs classify requests; they do not prove delivery, installation, fee collection or field NFC operation.

UI: all requests / installation / branch pickup tabs; method visible in each request row; pickup details omit unnecessary coordination contact fields. No new request store.

TDD RED: run 39979242429, job 120501871977, commit 3a7e8d6 returned the pickup fixture under the installation filter. Require GREEN SQL/API/browser filter tests and exact function/ACL rollback before applying live.
Orval generated the OpenAPI changes on GitHub in run 40062359553, job 120778402571; the exact generated contract patch is copied into the repository while preserving unrelated custom client behavior.

Preflight baseline: live 0028; cards catalog MD5 `bd041ff8a089cced5cc5a6370e34333d`; ACL `{postgres=X/postgres,authenticated=X/postgres}`; default ACL 24 scopes/hash `c70fd3da5a6b0c24f1ac2bac5657bcb3`; legacy status MD5 `d6a0defdb1102d00b0743723db453bad`. Recheck immediately before application and compare after. Forward guards and rollback require the reviewed definition and unique anchors.

Status: prepared; not applied.
