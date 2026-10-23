# Fleet directory photo identities — 0028

Target: Supabase `msvgzsfzrqlrfpstthhe` only. 0009 remains deferred.

Source SHA-256: `0c670b5e4fb73933fdc9a1fb251da5c14f14756962da3d133a80b82c77a801a7`.
Rollback SHA-256: `e0852a99fe457cc98e572b362859da49a21d82fab9eae66b627da692749f6d0f`.

Extends the existing paginated administrative fleet catalog. Vehicle rows expose the latest uploaded image's document ID, never a storage path or signed URL. Only PNG/JPEG vehicle photos in attached/pending-review/approved states qualify; failed, incomplete and rejected uploads are excluded. Driver rows expose their currently effective active vehicle assignments with plate, branch and the same photo ID. No driver Auth account or personal photo is invented. All document download permissions remain enforced by the existing endpoint.

The same protected preview component serves vehicle details, vehicle directories and assigned vehicles in driver directories. Dialog zoom has native focus containment, Escape handling and focus restoration. Signed links remain transient component state, never saved to directory records or exports. Each image failure has a retry action; absent images use a truthful empty state. Branch/company vehicle rows use mobile cards and translated fuel labels.

TDD RED: commit cabd6b1, GitHub run 39975814094, acceptance job 120489978387 failed because the uploaded vehicle photo ID was absent from the catalog. Require full GREEN including browser previews, assigned plate/photo identity and exact function/default-ACL rollback before live application.

Preflight: catalog MD5 `2d2df7243983c0f823eede60ae4b7d68`; live ledger 0027. Capture and compare catalog ACL, all default ACL scopes and the legacy status definition immediately before/after. Source guards require the exact reviewed definition and unique replacement anchors. Rollback reconstructs and verifies the exact original definition. No grants, tables or business rows change.

Status: applied alone on 23 October 2026 as ledger `20261023152855`.
GREEN: commit `8aa32f7d42d855bc5fe6a81bc6f2f9b0cb166d10`, GitHub run 39978082855, acceptance job 120498009185 and real-auth-storage job 120498008637 both succeeded. Full isolated SQL/API/browser acceptance included directory photo identity, driver plate/image linkage, zoom, focus restoration, responsive layouts, rejected/incomplete photo exclusion and exact function/ACL rollback. No production fixtures were used.
Fresh preflight matched 0027 and catalog MD5 `2d2df7243983c0f823eede60ae4b7d68`. Postflight MD5 `1fee4e7e162c54ac9a13740d1ea7768b`; both photoDocumentId and activeVehicles contracts present. Catalog ACL `{postgres=X/postgres,authenticated=X/postgres}`, default ACL 24 scopes/hash `c70fd3da5a6b0c24f1ac2bac5657bcb3` and legacy status MD5 `d6a0defdb1102d00b0743723db453bad` unchanged. No business rows, grants or status changes.
The current source has automated interactive/responsive evidence and captured screenshots; a fresh manual visual review of every role is still open. Source/DB activation does not deploy the web/API runtime.
