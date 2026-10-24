# Fleet simplification acceptance — 23 October 2026

Scope: `pertomaxeg-svg/petro-web`, branch `pertomax-central-orgs-20261015` only. Supabase reference `msvgzsfzrqlrfpstthhe`. No deployment, live business writes, new secrets, or live migrations performed in this continuation. 0009 remains deferred.

## Recovered and implemented

- Preserved seven interrupted Replit source/test/migration files in `a4fc83c`; Replit agent was quota-stopped without a final report.
- Removed visible manual audit-reason controls across central administration, organizations and reviews, billing, catalog, finance, fleet and inventory. Existing audit contracts still receive automatic descriptions; actor/time logging and authorization remain in place. This is not a user-written explanation or a new before/after audit subsystem.
- Vehicle NFC pickup omits installation contact details; installation retains coordination data. Driver creation generates its internal identifier deterministically on the server and links immediately without manual start/end dates. Driver records remain operational records, not Auth accounts.
- Vehicle onboarding exposes full-day use, allowed weekdays, four service groups and one daily/weekly monetary budget. Operation amount derives from the daily budget; optional monthly and period-quantity limits use zero to mean unconfigured. Quantities retain service units. Fuel quantity is validated in the form against tank capacity; monetary budgets are entered by the authorized operator, not guessed from tank size.
- Removed merchant selection from vehicle onboarding. The API copies the latest published branch network in force at policy start. Missing/empty branch scope fails closed. Runtime branch and vehicle restrictions still intersect. This copies a versioned scope; later expansion of the branch network does not automatically widen an existing vehicle version.
- Fixed the recovered driver-create TypeScript error and explicitly allowed the existing esbuild dependency build in pnpm workspace configuration.
- Fixed 0025's wrong migration target: limit checks live in `petro_private.fleet_check_usage_policy_at`, introduced by 0016. The now-bound wrapper and reservation RPC are not the evaluator body. Forward and rollback SQL target the actual evaluator.

## Verified evidence

- Full workspace typecheck passed after recovery fixes.
- API and production web builds passed. API bundle remains approximately 3.3 MB; largest web bundle approximately 362 KB.
- Six Node tests passed for PIN encryption and branch-scope selection, including tenant/branch isolation, drafts/future versions, newest version selection, and fail-closed empty scope.
- Isolated PostgreSQL onboarding/optional-limit migration smoke passed after target correction.
- Chromium UI smoke passed: plan and fuel draft edits persisted across reads/reload; vehicle and odometer images saved/reloaded/retried/zoomed; vehicle creation retry did not duplicate records; automatic PIN and driver relinking invalidated the previous PIN; NFC pickup/installation requests appeared consistently; QR approval/issue/revocation and responsive drawer/layout checks passed.
- API integration passed, including 90 focused inventory assertions. Fleet/finance integration passed 52 follow-up assertions and finance concurrency checks passed.
- The browser run uses a synthetic owner authentication fixture, real API routes and disposable PostgreSQL, with in-memory private Storage. It does **not** prove live Supabase Auth or live Supabase Storage behavior.
- The first full rollback pass correctly refused persisted optional-limit policies. The runner now checks that refusal explicitly, normalizes disposable fixtures only, and separately exercises the compatible downgrade. The final complete rerun passed with `ISOLATED_EXIT_CODE 0`, including the guarded 0025 downgrade and 0024 card-history rollback.

## Acceptance remains open

1. Complete isolated runner verified: exit 0; rollback guard, compatible downgrade and default ACL comparisons passed. This closes isolated technical checks, not all product acceptance.
2. 0025 has not been applied live; simplified optional-limit controls remain gated by capability version 3. No live migration approval is granted by this checkpoint.
3. Real authorized Supabase Auth and Storage verification, without production business transactions.
4. Full visual comparison of the vehicle and driver lists against the supplied screenshots, and remaining field/layout simplification. Do not claim pixel-identical completion from the smoke checks.
5. No new service-cycle, settlement, withdrawal or mobile-app phase started. Close and connect existing fleet/cards/limits acceptance before new construction.
