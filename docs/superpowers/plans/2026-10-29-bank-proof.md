#0044 private bank-transfer proof —29October2026

Dependent slice of approved bank payout plan. Complete real private proof create/upload/metadata verification/read, exact retry, SHA256 recorded by API from actual bytes, immutable acceptance, current approved request/version/bank binding. Proof alone never pays money. Actual full/partial bank posting remains next0045, using this verified object contract.

Only approved repository/branch/Supabase; no Replit/local checkout/build/other project/VPS/paid resource;0009 deferred. Tests/build in Actions. No live synthetic file/payment/bank data.

Private intent + acceptance + actor-key receipt tables (RLS/no direct client grant). Reuse private bucket with two narrowly scoped Storage SELECT/INSERT policies; no UPDATE/DELETE. Finance/owner creates/uploads/finalizes, current organization-level merchant financial users/auditor read accepted history. Pending file reads restricted to current authorized uploader. Exact current approval version and frozen beneficiary account revision required at upload/finalization. Lock request before proof (never acquire payment locks from proof flow); future payout keeps payment→request→proof/account lock order.
API validates magic bytes and length, uploads without upsert, downloads stored bytes on retry and compares exact content, computes SHA256. SQL independently verifies actual Storage object ID/owner/size/MIME and records ETag plus uploader-attested digest; SQL does not download bytes or independently authenticate the bank transfer. No claim that a digest attestation is a bank verification or unforgeable server signature.
All history immutable; stale accepted proof remains readable but cannot become current after refund/version/bank changes. List UI explicitly shows stale/current version. No paid button or transfer simulation.
RED missing-proof gate → isolated SQL metadata/role/stale/immutability tests + genuine Auth/Storage bytes/read/download/overwrite/outsider/revocation + HTTP/browser upload/failure/retry/reload/mobile. Preserving rollback refuses any intent/acceptance history, independent clean rollback restores old schema/defaultACL/policies. Apply exact accepted SQL and verify live bodies/grants/unchanged data only after GREEN.

## Acceptance checkpoint —29October2026

- [x] Regression-first missing-proof RED, scoped schema/API/UI, strict upload bytes and immutable acceptance.
- [x] SQL/HTTP/browser390+1280, genuine isolated Auth/Storage, expiry/stale/retry/revocation/overwrite/delete tests GREEN at74e5b619307c99f9d35d826bcac31b5b2d764377.
- [x] Independent preserving rollback including exact Storage policy/defaultACL restoration.
- [x] Manual screenshot inspection, exact live migration20261029071845, seven body hashes, unchanged old objects/defaultACL/business counts, advisors postflight.
- [x] Saved acceptance evidence and current continuation. Actual bank payout is next0045, not completed by this slice; runtime deployment remains open.

Evidence: docs/acceptance/2026-10-29-merchant-bank-proof.md.
