# Issued-card active/inactive categories — 0027

Target: Supabase `msvgzsfzrqlrfpstthhe` only. 0009 remains deferred.

Source SHA-256: `5be6c33cf0376ff6b57ec764efa7356bfd94511449a192b291cde8f1fa15ec93`.
Rollback SHA-256: `93b04000b98a3c00fb1f996b5837697e656c06e83815435589571451bfe8110a`.

The existing issued-card catalog accepts `status=inactive` as every non-active issued credential, including stopped and revoked. Exact status filters retain their current behavior. Pagination and totals use the same database filter; no client-side truncation or fabricated counts. Requests and stock retain their own states. The UI provides all/active/inactive issued-card tabs synchronized with the existing filter.

TDD RED: CI run 39973147561, commit fc410d0, returned no rows for the revoked-card fixture under the inactive category. Full GREEN, browser category checks and exact function/ACL rollback are required before live application.

Preflight baseline: current live migration 0026; catalog definition MD5 `308dc1e9c3c9b9c835cbe3bcdefc3b61`. Default ACL 24 scopes/hash `c70fd3da5a6b0c24f1ac2bac5657bcb3`; legacy status MD5 `d6a0defdb1102d00b0743723db453bad`. Recheck immediately before application. Apply only the exact reviewed source and verify ledger, catalog filter, unchanged catalog ACL/default ACL/legacy. No business rows, grants, credentials or status transitions are changed by the migration.

Rollback restores the exact original predicate without rewriting data. Test definition/ACL restoration in GitHub Actions before deployment.

Status: applied alone on 23 October 2026, ledger version `20261023150540`.
Full isolated SQL/API/browser acceptance and exact rollback passed in GitHub run 39973972305 (acceptance job 120483648240). Fresh live preflight matched 0026 and the reviewed fingerprints. Postflight catalog MD5 `bd041ff8a089cced5cc5a6370e34333d`; inactive predicate present, catalog ACL `{postgres=X/postgres,authenticated=X/postgres}`, all 24 default ACL scopes/hash and legacy definition unchanged. No business rows or credentials created or updated.
The separate real Auth/Storage job passed in prior run 39973147561; the first attempt of 39973972305 hit a public container-registry quota before tests and was retried once. This does not prove production runtime readiness.

Retry outcome: run 39973972305 attempt 2, real-auth-storage job 120488006449, passed actual isolated Auth/PostgREST/Storage acceptance and cleanup.
