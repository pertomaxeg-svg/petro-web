# Operational PIN identity proof — 0031

Project: `msvgzsfzrqlrfpstthhe`; repository `pertomaxeg-svg/petro-web`; branch `pertomax-central-orgs-20261015`. 0009 remains deferred.

Source SHA-256: `d9d141a29969176172ba71f04537c72054bad407fe60af38af51b9922ef365f8`.
Rollback SHA-256: `de08d4c322de765a221e631603db58608da45ec6f3a9a317f64722868f09baa3`.

## Behavior and boundaries

A confirmed active worker with an executable 0030 branch/service assignment can submit a scanned credential and four-digit driver/vehicle PIN through the server API. The raw PIN is converted to the existing domain-separated vehicle HMAC using the existing SESSION_SECRET; it is never stored in the proof tables or returned. This change does not rotate a secret or change legacy fleet PIN behavior.

The pre-PIN database context returns only an opaque vehicle UUID for server-side HMAC calculation. No plate, driver identity, fleet catalog, wallet or balance is disclosed. A valid two-minute proof belongs to the caller, exact assignment/version, merchant branch/service, active credential, vehicle company branch, driver link and active PIN-secret identity. Scope, membership, account/password gate, credential/link/secret/branch state and expiration are checked again when reading or replaying a proof.

Failed attempts share the existing per-vehicle five-attempt/15-minute limiter. Exact idempotent retries do not count twice; an already-successful request cannot revive an expired or invalid proof. No driver Auth account, transaction, inventory movement, financial hold or payment is created. Identity verification is a prerequisite, not authorization to charge: subsequent service orders must recheck policy, subscription, current approved prices, funds and stock; final PIN confirmation must bind the final order/version/amount.

## API and worker page

- GET /api/operations/capabilities adds a boolean runtime-readiness flag; never a secret.
- POST /api/operations/pair-verifications accepts branchId, serviceGroup, credentialToken, pinCode, idempotencyKey. Strict fields; authenticated caller JWT only.
- GET /api/operations/pair-verifications/:id returns only the caller's still-valid proof, or valid=false.
- /operations shows executable branch/services, masked PIN (including leading zeros), clears submitted PIN and successful credential, and expires the displayed proof. Arabic/Persian digits normalize locally. No PIN/token URL or browser storage, no financial action disguised as completed.
- Missing existing runtime HMAC secret fails closed with 503. Runtime deployment readiness is separate from DB migration status.

## Verification and release gate

SQL RED: run 40066708974, absent context RPC. SQL GREEN: run 40068415924; scope, exact replay, lockout, expiration, assignment-version and PIN-secret rotation, guarded rollback and exact original schema/default ACL restoration.
HTTP RED: run 40069294663 / acceptance 120799054187, missing readiness field, as expected.

API/browser and actual Auth/PostgREST coverage extended in subsequent commits; record final GREEN before live application. Browser fixtures use separate owner/worker proxy origins and only disposable PostgreSQL data; real Auth test uses loopback Supabase and synthetic confirmed accounts, not owner credentials or production data.

Preflight: latest ledger0030; all new objects absent; exact source/rollback fingerprints; 24 default ACL scopes hash unchanged; legacy status definition and existing fleet grants unchanged. Apply 0031 alone only after final GREEN.
Postflight: two private tables RLS/no direct anon/authenticated/service_role DML, public RPC execute only authenticated, private proof validator inaccessible to clients; same default ACL/legacy/fleet grants; zero live proof/receipt rows.

Rollback refuses any persisted proofs/command receipts. Never delete live proof records to force a downgrade. Disable the workflow and use a preserving forward repair if data exist.

Status: source reviewed and SQL-tested; API/UI integration and generated contracts under acceptance. NOT applied live yet; web/API NOT deployed.
