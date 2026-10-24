# Pertomax EG Completion Implementation Plan

> **For agentic workers:** execute inline using the reviewed writing-plans, executing-plans and test-driven-development guidance. The owner explicitly authorized continuous direct implementation, ordinary commits, database migrations and deployment; do not wait for routine plan approval. Use checked tasks as the restart ledger.

**Goal:** complete the approved four web workspaces, shared service/finance/inventory contracts and final worker apps, with verified isolation, usable Arabic interfaces and deployable operations.

**Architecture:** retain the React/Vite web app, Express API and Supabase Auth/PostgreSQL/Storage. Database commands own atomic financial transitions; the API validates identity, scope and inputs; all web workspaces use the same contracts. Extend existing modules rather than recreate tables, auth or ledgers.

**Tech Stack:** TypeScript, React 19, Vite, Express 5, pnpm, PostgreSQL 17 tests, Supabase, existing OpenAPI generators and Node test runner.

**Spec:** `docs/PERTOMAX-EG-ENGINEERING-REFERENCE-v3.md`, latest owner requests and eight supplied vehicle/driver screenshots. Latest owner simplification overrides old reason, manual link-date, time-window and merchant-selector requirements.

## Global constraints

- Sole repository: `pertomaxeg-svg/petro-web`; active branch `pertomax-central-orgs-20261015`.
- Sole Supabase project: `msvgzsfzrqlrfpstthhe`; 0009 remains deferred.
- Egypt/EGP, integer piastres, exact numeric quantities; timestamps UTC and policy day `Africa/Cairo`.
- Four web workspaces: central admin, company, station, provider. Drivers are operational records without an Auth account or driver app.
- Preserve existing user data, balances, historical snapshots, RLS, narrow grants, 0008 and legacy status RPC. No production deletes or paid resources without required authorization.
- Direct development/build/testing/deployment: no dependency on the Replit agent or runtime. Production destination must belong to this project; no unrelated VPS.
- A passing build is not acceptance. Every item records test command/result and live/isolation boundaries.

## Review focus

1. Retry after partial creation: no duplicate vehicle, PIN link, file, request, journal or inventory movement.
2. Midnight/week boundary, decimal money, concurrent authorizations: limits and available funds remain correct.
3. Suspended account, changed role/branch, expired subscription or revoked credential: server rejects operations even with stale UI.
4. Missing price, unavailable item, empty scope or failed storage: fail explicitly without invented records or widened access.
5. Small-screen RTL and keyboard navigation: primary actions, errors, images and tables remain readable and reachable.

## Evidence baseline (23 October 2026)

- Fresh local HEAD `c65dd6f`; clean working tree before this plan.
- Live migration catalog ends at 0024 (`20261022061312`); 0025 absent. Live default ACL: 24 scopes, fingerprint `c70fd3da5a6b0c24f1ac2bac5657bcb3`.
- Existing routes: auth, management, organization-workflows, billing, finance, fleet, catalog, inventory. No orders or settlements route/module yet.
- Existing isolated suite passed previously, including browser/real SQL, with synthetic Auth and in-memory Storage; reproduce on independent infrastructure before closing direct-development setup.
- Security advisor findings require per-function authorization review; SECURITY DEFINER visibility alone is not evidence of a bypass. Leaked-password protection is disabled; assess plan availability before changing it.

## Phase 0 — independent verification, migration and release foundation

**Files:** this plan; `lib/db/scripts/apply-approved-admin-migrations.mjs`; `lib/db/rebuild/run-local-test.sh`; `.github/workflows/verification.yml`; `docs/DEPLOYMENT.md`.
**Consumes:** existing migrations 0001–0025 and isolated runner. **Produces:** independent CI acceptance, reviewed 0025 preflight/postflight, build/release instructions.

- [x] Inspect current branch, live migration catalog, tables and security advisories.
- [x] Locate named skills from primary repositories; record sources and actual usage below.
- [x] Establish PostgreSQL 17/browser verification independent of Replit; require no production secrets. CI run 39967922067 passed the complete suite on 23 October.
- [x] Add 0025 to reviewed migration allowlist and rollback documentation; check source hash, current function definitions, constraints, ACL and legacy fingerprints before applying only 0025.
- [x] Verify capability 3 and unchanged ACL/legacy signatures after application; no test business records live. Applied ledger version 20261023141941; see rollout evidence.
- [ ] Identify existing project-only production target, secrets and DNS requirements. Prepare rollback/health probes, then deploy only a tested release. Missing target blocks deployment, not development.

## Phase 1 — close existing fleet/cards/catalog/billing acceptance

**Files:** `artifacts/pertomax-eg-web/src/FleetAdmin.tsx`, `FleetDirectory.tsx`, `FleetCardsAdmin.tsx`, `FleetCardRequestsPanel.tsx`, `CatalogAdmin.tsx`, `AdminBilling.tsx`; API fleet/catalog/billing routes; isolated UI smoke.
**Produces:** COM05–COM09 and ADM05–ADM11 acceptance foundation.

- [ ] Match approved vehicle fields and driver/vehicle lists: useful columns, vehicle and odometer images, private zoom, responsive details; no driver Auth fields.
- [ ] No visible manual audit-reason fields; automatic actor/time/event descriptions stay audited.
- [ ] Pickup requires branch/pickup location only; installation requires only necessary coordination data. NFC request has one identity across vehicle/company/cards, with installation/delivery history and stock linkage.
- [ ] Automatic secure pair PIN, authorized reveal, timed hiding, old PIN revoked on reassignment; no code in logs/export/cache. Verify live key readiness without exposing its value.
- [ ] Full-day allowed weekdays/services; one vehicle daily/weekly monetary budget. Validate quantity/tank and monetary limits on server as well as UI; preserve parent branch policy restrictions.
- [ ] Edit/publish/read/reload plans and fuel reference tariffs, including conflict recovery and preserved old subscription snapshots.
- [x] Authenticated real Storage upload/download/denial with explicitly isolated test resources; real Auth/PostgREST/Storage job passed in GitHub run 39973147561. Production runtime secrets and SMTP delivery remain unverified.

## Phase 2 — service order cycle (first new business phase)

**Create:** API orders module, web orders module, numbered additive migration, SQL/API/browser order tests; update OpenAPI.
**Consumes:** credential resolution, pair verification, catalog/price versions, branch/vehicle policies, finance and inventory reservation functions.
**Produces:** typed order lifecycle and ADM13 / COM10 / STA02/05/06/09 contracts.

- [ ] TDD: reject cross-tenant/branch/role, provider fuel, missing price, expired coverage, revoked card/PIN and insufficient budget/funds/stock.
- [ ] Resolve credential; first PIN authorizes and reserves exact amount/quantity against approved scope and price snapshots. Do not log PIN or expose company wallet to worker.
- [ ] Start service, record actual quantity/odometer/evidence and line snapshots; distinguish fuel, wash, oils/parts/labor and their units.
- [ ] Second PIN confirms final values; atomic capture, company charge, merchant payable and inventory consumption exactly once. Test simultaneous attempts, timeout, changed payload and commit-response loss.
- [ ] Cancel/expire releases all reservations atomically. Finalized order immutable; adjustments become linked refund/correction records.
- [ ] Role-scoped list/details/actions, filters/pagination, timelines, all UI states; browser role scenarios against real isolated SQL.

## Phase 3 — withdrawals, settlements, refunds and documents

**Create:** settlement/refund modules, migrations and tests; shared receipt/invoice rendering.
**Consumes:** finalized orders and merchant payable ledger. **Produces:** ADM14–ADM18, COM11–COM12, STA10–STA11/provider equivalents.

- [ ] Settlement eligibility and periods configured per merchant; available/held/paid separated. Reserve withdrawal claims so branch/central requests cannot overlap.
- [ ] Maker/reviewer decisions and partial payouts with exact allocations; bank proof alone never marks payment. Authorized confirmation, single journal event and immutable references.
- [ ] Refund no greater than remaining captured amount; company funding restored, payable adjusted; physical stock returns require inspection and explicit stock movement.
- [ ] Warranty claim/inspection/repair/replacement, original sale linkage and no hidden new charge. Store immutable document snapshots and regenerate Arabic PDF safely.
- [ ] Concurrency, idempotency, failed storage, masking and reconciliation tests across every money transition.

## Phase 4 — complete central administration

**Files:** existing central shell/pages plus separate focused modules for orders, settlements, documents, reports, support and operations.
**Produces:** all ADM01–ADM22 from reference §5.1.

- [ ] Real dashboard summary and queues; organizations/branches/requests/users/roles with scope and optimistic conflicts.
- [ ] Working plans/subscriptions, financial funding/receipts/transfers, fleet/cards, catalog/prices, orders, settlement/refunds, stock/warranty, documents.
- [ ] Reports/export agree with ledger; support/internal notes separated, notifications/outbox retries and operational health/audit views.
- [ ] Explicit section capabilities mapped to actual existing roles; no self-escalation, stale role access or cosmetic-only checks.

## Phase 5 — complete company workspace

**Produces:** all COM01–COM14 in reference §5.2 using shared APIs.
- [ ] Main/branch available/reserved funding without double counting; organization/users/subscriptions and renewal coverage.
- [ ] Scoped fleet/drivers/policies/credentials/documents/odometer/maintenance and authorized imports.
- [ ] Order histories, funding/transfer requests, documents/reports/support/notifications. User can act only inside granted branches.
- [ ] Company manager, branch manager, finance, fleet and viewer browser scenarios, including negative ownership tests.

## Phase 6 — complete station and provider workspaces

**Produces:** STA01–STA13 and reference §5.4 provider workspace.
- [ ] Station free eligibility, fuel/wash/oils/parts, catalog/prices, worker assignments, operations and issuance/install tasks.
- [ ] Provider has no fuel, independent branch subscription eligibility and annual price overrides; expired subscription does not prevent reading/claiming earned payable.
- [ ] Inventory, warranty, order documents, payable/withdrawals, reports/support; worker sees task data only and cannot edit price or approve own payout.
- [ ] Full browser journeys for manager/finance/worker/scoped branches and suspended/expired cases.

## Phase 7 — public experience, accessibility and release acceptance

**Files:** existing public pages, shared design tokens/shells, API limits/logging/health and deployment documentation.
- [ ] Complete public home/service/company/station/provider/contact/legal/auth/recovery pages using existing identity and real content; no inactive links or invented testimonials.
- [ ] Arabic RTL at 360/390/768/1280px, keyboard/focus/dialog/drawer, contrast, reduced motion and useful loading/error/empty states. Tables become mobile summaries with detail views.
- [ ] Performance budgets, masked structured logs, timeouts/rate limits, session/CSRF checks, retention/export and least-privilege review.
- [ ] Reproduce whole suite and reconciliation, real Auth/Storage acceptance, backup/restore and rollback rehearsal, project-only release health checks. Record blockers rather than declaring unsupported success.

## Phase 8 — worker applications (last)

- [ ] Fuel worker, wash worker, provider worker apps only after the web/API/finance/inventory acceptance above. Reuse service-order APIs and branch/service assignments.
- [ ] Device NFC/QR, poor connectivity, duplicate submissions, PIN privacy, role revocation, accessibility and physical-device test matrix. Offline queue never implies financial approval.
- [ ] Build/distribution configuration, crash/privacy controls and release instructions. Any store fees require actual authorized account/cost availability.

## Skills and execution rulings

- Frontend Design: `anthropics/skills`, `skills/frontend-design/SKILL.md`, blob `a5333457c414d20d625f307df945842c0952ecc3` — read; apply to live React components, retain the established green brand.
- Writing Plans: `obra/superpowers`, blob `4cf0275d88d67aa4ef09f4bbca9970ed6ff74a00` — read. Explicit owner instruction overrides its routine plan-approval pause.
- TDD: `obra/superpowers`, blob `46838cc9e893c06259e3bdad0fc2425b36242f15` — read with writing-good-tests reference. Record red and green runs for business changes; configuration/docs use appropriate validation.
- UI UX Pro Max: `nextlevelbuilder/ui-ux-pro-max-skill`, `.claude/skills/ui-ux-pro-max/SKILL.md`, blob `41f8e2fd7f8c568228d0b55186ebe3f7b4007377` — read fully; load supporting rules before design implementation.
- Canvas Design: `anthropics/skills`, blob `9f63fee82de84cd4230e1d0e322247b61eb4c94c` — read; use only when a static visual deliverable is needed, not for interactive screens.
- Execution: inline direct work authorized. No Replit agent/runtime for future builds/tests/deploys. No routine approval pause; irreversible deletion, mandatory security confirmation or new costs retain their actual boundaries.

## Restart ledger

- 2026-10-23: plan created before new implementation; independent verification setup in progress. Existing isolated results are historical evidence, not a fresh direct-run claim.
- Next: close Phase 1 server-limit and visual acceptance. Independent CI and 0025 live activation completed; no project-wide completion claimed.
- 0026 capacity guard: real PostgreSQL regression observed RED in CI 39969027525 (2.501 litres accepted for a 2.5 litre tank). Add a guard to the private evaluator and require full GREEN plus exact definition/ACL rollback before applying. Keep live Auth/Storage and visual acceptance open.
- 0026 GREEN: full CI run 39969626095 passed; applied alone as 20261023142953 with unchanged default ACL/private evaluator ACL/legacy status definition. No business fixtures live. All eight supplied screenshots visually inspected: current form complaints and PetroApp reference forms/directories distinguished; no driver Auth fields copied. Directory columns now prioritize plate/name, useful state and links; mobile rows become cards, and the wizard uses a larger, readable form. Browser acceptance/evidence for these UI changes is next.
- UI CI 39970478630 passed at 9c69620, including directories and 360/390/768/1280/1440px overflow checks. Visual inspection of the saved mobile evidence caught screenshots taken mid-sidebar transition; wait for actual CSS animation completion and assert the closed drawer is outside the viewport before recording replacement evidence. Do not treat the earlier mobile screenshots as final visual approval.
- Real Auth/Storage acceptance: add a separate secret-free GitHub job using disposable local Supabase containers, real email-token verification, real PostgREST RPC authorization and real private vehicle/odometer image storage. Strict loopback checks prevent accidental production DB/API usage; no local Auth/Storage bootstrap stubs are loaded. This verifies isolated services, not production key readiness, SMTP delivery or a fully authenticated production browser session. Run and fix this job before marking it passed.
- Real services started in CI 39971542073; schema import stopped at managed-role default privileges before Auth tests. Apply only those 12 reviewed supabase_admin default statements via the disposable container's DB administrator, keep application objects owned by postgres, and rerun. The independent browser/SQL/API acceptance job passed on the same commit.
- Add a RED regression for the inactive issued-card category: revoked cards must appear there and be excluded from the active category. This closes the missing active/inactive navigation requirement; no live 0027 application until observed RED→GREEN and rollback verification.

- Ruling: local runtime maps only uid 0; native PostgreSQL refuses root and privilege switching is unavailable. Use secret-free GitHub Actions on this public repository for independent PostgreSQL 17/browser acceptance; retain local Node/build checks. No Replit fallback.

- Independent CI: first run exposed PostgreSQL 17.11 metadata drift; three normalizer regressions observed RED→GREEN. Second run passed SQL but Chrome startup failed without diagnostics. Remove obsolete constrained-runtime flags and capture bounded browser stderr/signal for the next run.

- Independent CI run 39966868322: standard Chrome browser acceptance, real API/PostgreSQL and finance concurrency passed. The later rollback guard check failed because ripgrep was missing; install the explicit runner dependency and rerun the whole suite. Auth and Storage remain synthetic; live acceptance is still open.

- Owner clarification, 23 October: code mutations directly through GitHub on the approved branch; database mutations directly through the approved Supabase connector. Use GitHub Actions for verification; no Replit or separate external development/hosting project. Local preparation is not a deployed feature. Current live ledger ends at 0026. The real-services test is GitHub-hosted and must retain Supabase-managed role defaults rather than rewriting them; its acceptance is still open. Repair the anonymous test block label before interpreting the inactive-category regression result.

- 0027 RED observed in CI 39973147561: inactive issued-card list returned total=0 for a revoked fixture. Implement aggregate inactive filter and synchronized issued-card tabs; test the browser and exact catalog/ACL rollback. Native driver verification panel becomes collapsed by default so it does not obscure the directory. All these code changes are authored directly through GitHub; 0027 remains unapplied pending GREEN.

- 0027 applied alone as 20261023150540 after GREEN SQL/API/browser and exact rollback; catalog/default ACL/legacy unchanged. Real Auth/Storage retry in 39973972305 passed (job 120488006449). Next RED regression: paginated vehicle directory must return its uploaded photo identity, and driver directory must identify its active vehicles and the same protected image. No signed storage URLs in directory data. Implement 0028 only after observed failure.

- 0028 RED confirmed: GitHub run 39975814094 failed on missing uploaded photo identity. Implement catalog-only photo IDs/current driver vehicle identities, shared protected previews with native modal focus, mobile company/branch vehicle cards and translated fuel labels. Require GREEN and exact rollback before live activation. Code authored directly through GitHub.

- 0028 first GREEN attempt 39976425064 passed types/build and catalog/photo assertions, then exposed focus not returning after image-dialog removal. Explicitly restore the connected thumbnail after closing; retain native focus containment. Add rejected/incomplete photo exclusion SQL checks. Real-services startup hit ECR quota again before tests; last actual real-services success remains 39975814094.

- 0028 follow-up run 39977088172 passed the new photo identity and native focus-return checks; the next list test attempted to type before the route search field mounted. Wait for the actual control before typing. Simplify detail facts to approved useful vehicle/driver fields; remove duplicated generic detail tables and the driver operational code from the driver detail presentation. Chassis/internal/date metadata stays collapsed, preserving data and existing edit actions.

- 0028 final GREEN: run 39978082855 at 8aa32f7 passed full acceptance plus real Auth/PostgREST/Storage and cleanup. Applied alone as 20261023152855; catalog MD5 1fee4e7e162c54ac9a13740d1ea7768b, ACL/default ACL/legacy unchanged. No live business fixtures. Useful detail facts and private list images verified through the browser; full manual role-by-role visual match and production runtime key readiness remain open.
- CI duplication verified directly: commit 8aa32f7 started push run 39978071291 and PR run 39978082855. Keep PR checks for feature branches and push checks for main, plus manual dispatch; remove the duplicate approved-branch push trigger. Add deployment contract based on current Express/Vite/configuration sources; do not claim hosting exists.
- Next implementation: complete NFC installation/pickup request navigation with server pagination and explicit fulfillment filtering; preserve shared request identity and avoid labeling pickup as physical installation. Then finish phase-1 role/visual acceptance and start the service cycle against the existing finance/usage/inventory contracts. Production hosting, key provisioning and physical NFC are external gates; no fake completion.

- Start 0029 request-navigation TDD: installation/pickup are fulfillment filters over the shared request catalog, not a second request store or a claim of physical delivery. RED test must reject a pickup row in the installation view, preserve server totals/pages and reject unknown methods. Keep actual delivery evidence and field NFC acceptance separate.

- 24 October 2026: 0029 RED observed in 39979242429: installation filter returned the pickup request. Implement database-before-pagination fulfillment filtering, strict OpenAPI/API validation and all/install/pickup request tabs. Actual Orval contract patch generated on GitHub in 40062359553 and copied without unrelated client rewrites. Require full GREEN and exact rollback before live activation.

- 0029 GREEN and live: 24 October, run 40062548670 at 5b5e132 passed full SQL/API/browser and exact rollback; real Auth/PostgREST/Storage checks and cleanup passed. Applied alone as 20261024043222; card catalog MD5 a819fa4e6f8dff44ff29777f9319c8b2, ACL/default ACL/legacy unchanged. No business fixtures live. Orval regeneration 40062548665 has zero contract drift.
- Next restart: finish phase-1 protected role/visual readiness and explicit NFC fulfillment evidence/collection linkage; do not equate request tabs with physical completion. For the service-cycle foundation, fresh schema inspection found only the administrative driver-pair verification RPC and no worker-named assignment table. Review actual membership/branch capabilities and add narrowly scoped worker/service assignments and operational verification; never grant workers the administrative fleet verification/catalog as a shortcut. Then implement orders/reservation/execution/second-PIN capture with the existing money/usage/inventory contracts. Deployment host/runtime key presence remains unverified.

- 0030 workforce foundation: RED 40064750383 confirms worker assignment RPC absent. Implement central owner/operations assignment management, read-only audit access, paginated branch-eligible member candidates and caller-only capabilities; deny self-assignment, company execution and provider fuel/cards. Recheck current Auth/profile/membership/branch scope on every use. Add real SQL/API/browser save/reload and guarded empty rollback tests before activation. No admin fleet access is granted to workers. PIN/order/financial integration and OpenAPI generation are still open.

- 0030 acceptance GREEN in run 40065646702: real SQL scope/replay/revocation/temporary-password checks, HTTP role denial and browser assignment save/reload/provider-fuel disabling passed; rollback refused persisted synthetic records and restored the exact schema/ACL after isolated fixture cleanup. Orval generation in 40065646741 succeeded; copy generated schema/client additions while preserving unrelated custom hooks, use generated Zod request contracts and rerun before live activation.

- Real-services CI startup hit ECR shared-IP data quotas again. Verified pinned Supabase CLI v2.58.5 internal/utils/docker.go GetRegistry/GetRegistryImageUrl and cmd/root.go SUPABASE env prefix from upstream source: docker.io selects original pinned images. Use that supported upstream registry without a CLI/image-version change or new credentials. Extend the real-services test through 0030 with an actual confirmed worker JWT, assignment replay, direct-table/admin/self-assignment denial and immediate membership/password/branch revocation. No production Auth users or data.

- 0030 final GREEN and live: run 40066038275 at 97fb8ce passed full SQL/API/browser plus actual Auth/PostgREST worker JWT revocation and Storage; generated contract run 40066038258 has no drift. Applied alone as 20261024052703. All three tables have RLS/no direct client DML; public RPC grants exactly authenticated, private execution gate not client callable, default ACL/legacy/admin fleet ACL unchanged; zero live assignments. No production test records.
- 0031 next: add a separate operational PIN proof bound to auth.uid(), current worker assignment/version, merchant branch/service, active scanned credential, driver link and active PIN-secret identity. Use shared per-vehicle attempt limits; expired/revoked/reassigned/rotated proofs must fail. No worker access to the admin fleet verification/catalog, no fabricated service-role claims and no wallet/full-fleet disclosure before PIN. Keep PIN/HMAC/token data out of logs/cache/export. A first proof authorizes a short-lived selection/reservation step only; a second proof must later be bound to the actual order/final amount before capture. Existing service-role-only usage reservation cannot be called by pretending the worker is service_role: extract a private shared core with preserved legacy wrapper in the subsequent order migration.

- 0031 RED observed in 40066708974: operational credential-context RPC absent after valid scoped fixtures. Implement separate actor/assignment-version/branch/service/credential/link/secret-bound two-minute proofs; shared per-vehicle lockout; exact failed/success replay without extra attempts; invalidate on assignment change, company-branch movement, expiry and PIN-secret rotation. Opaque pre-PIN vehicle identity is internal HMAC context only; no fleet/driver/wallet details before a valid PIN. No financial capture yet. GitHub CI computes source/rollback SHA-256 using Node crypto; long Supabase hash-only reads encountered transport metadata errors, so no live application is attempted from unverified source.

- 0031 HTTP/UI work: first require runtime readiness and operational request validation in a failing CI test. Implement a shared legacy-compatible HMAC helper (no PIN-secret rotation), caller-JWT-only operation routes, masked four-digit PIN including leading zeros, no sensitive browser persistence, and a separate worker-cookie browser origin. Acceptance includes wrong-PIN nondisclosure, same-request retry, owner/other-actor denial, immediate assignment-stop invalidation and responsive worker verification. New OAS contracts generated by the repository workflow; no production fixtures. Remains identity proof only, not a completed service/payment cycle.

- 0031 final GREEN and live: commit864f718d / run40069746677 (acceptance120800669333, real-auth-storage120800669062), generated contracts no drift in40069746681. Applied alone as20261024062426. Worker API/browser verified leading-zero PIN, masked/cleared inputs and responsive layouts; real JWT proof scope/replay/private-table denial passed. Direct live postflight: preserved defaultACL/legacy/five prior function definitions/grants, all new explicit grants/RLS correct, zero live proofs/receipts/assignments. Runtime still not deployed.
- Next dependency0032: extract an internal policy/funding reservation core while preserving the existing service-role-only wrapper, its verification, payload hash/replay/return shape and grants. New core gets no anon/authenticated/service_role execution grant. Reuse it later only from explicitly actor/proof-authorized order commands; never fabricate service-role claims. Require a failing missing-core test, funded holds/replay/policy atomicity tests and exact rollback/schema/ACL restoration before application. This is an internal prerequisite, not a complete service order or payment workflow.

-0032 GREEN/live:6e0519eb, run40070333103 (acceptance120802283933, actual Auth/Storage120802284100); registered source/rollback hashes and applied alone as20261024095204. Core postgres-only/SECURITY INVOKER; legacy public service_role-only grant preserved,24 defaultACL/hash and legacy status unchanged, no usage/hold/journal/proof rows. Exact rollback schema/defaultACL verified in disposable DB. Next modules detailed in docs/superpowers/plans/2026-10-24-service-orders.md;0033 quotation first, then actual reservation/execution/final payment.
