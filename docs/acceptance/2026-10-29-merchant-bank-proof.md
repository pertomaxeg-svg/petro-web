#0044 merchant bank-transfer proof acceptance —29October2026

## Accepted scope and exact source

Only `pertomaxeg-svg/petro-web`, branch `pertomax-central-orgs-20261015`, Supabase `msvgzsfzrqlrfpstthhe`. Source edited directly through GitHub; isolated build/test in Actions. No Replit, local source checkout/build, other project/VPS/paid resource, force push, live synthetic bank/file/payment/user data or0009 execution.

Accepted functional commit: **74e5b619307c99f9d35d826bcac31b5b2d764377**.

- [Full independent verification40833779972](https://github.com/pertomaxeg-svg/petro-web/actions/runs/40833779972): acceptance123313713688 and genuine Auth/Storage123313713933 both SUCCESS.
- [Frontend40833779875](https://github.com/pertomaxeg-svg/petro-web/actions/runs/40833779875): SUCCESS.
- [API contract generation40833779928](https://github.com/pertomaxeg-svg/petro-web/actions/runs/40833779928): SUCCESS.
- Initial regression-first source9d5bd218f6d0335e071d7a493ab6171c5f8734fb, run40830995011 / acceptance123304933160 failed specifically `MERCHANT_PAYOUT_PROOF_MISSING`. This is the expected missing-function RED, not an accepted release.
- Final [browser artifact12879418908](https://github.com/pertomaxeg-svg/petro-web/actions/runs/40833779972/artifacts/12879418908): actual proof form/accepted history390px and1280px manually inspected. These are disposable test records. File picker, panels and actions fit both widths; mobile uses the existing card layout.

## Behavior

Central current Finance/owner creates a private PDF/PNG/JPEG upload intent,1–10,485,760bytes, bound to an actually approved withdrawal's exact current version, frozen approved beneficiary bank version and account revision. Request-key fingerprinting replays the same intent and rejects changed payloads. Own pending intents expire after20minutes; list RPC exposes server-authoritative `uploadAllowed` and `expiresAt`, and UI cannot resume an expired/stale intent.

API validates size and magic bytes, uploads without upsert, downloads stored bytes, compares the exact bytes and computes SHA256. Retry after an uncertain upload uses the same intent/file; another payload cannot replace it. Acceptance records actual Storage object UUID, owner, MIME, size, ETag and digest immutably. The actual input resets after success.

Current organization financial readers and central financial/auditor readers can read accepted history within0043 scope. Pending content is restricted to the current authorized uploader. API attachment download checks the stored-byte SHA256 again; attachments are no-store and nosniff. A separately authorized signed URL expires after60seconds. Private Storage has only narrow authenticated INSERT/SELECT policies for this new prefix; accepted files cannot be overwritten/deleted by client Storage APIs. There is no public URL attachment field.

Refund/cancellation/request-version or beneficiary bank changes leave accepted history intact with `current:false`; a stale intent cannot be newly accepted. UI shows historic/current proof and disables scope/request mutation while an uncertain upload is being retried. Bank display remains masked according to current financial read authorization.

**This is evidence handling, not a payment or bank verification service.** SQL independently verifies Storage object metadata/owner but does not download bytes. Digest is uploader-attested at the SQL RPC boundary; the application API computes/rechecks it from real bytes. An authorized Finance caller can directly attest a digest through the scoped RPC, so this is not an unforgeable server-only signature. No claim of independent validation that an external bank actually transferred money. A later payout flow must recheck the actual file/digest and apply its own authorized external-transfer controls.

No journal, paid status, automatic banking call, company re-charge, settlement allocation or debt offset is introduced. `bankPayoutEnabled:false` remains truthful.

## Data/security and tested boundaries

Three new immutable private RLS tables: `merchant_payout_proof_intents`, `merchant_payout_proof_acceptances`, `merchant_payout_proof_commands`; no direct anon/authenticated/service_role table grant. Seven functions: two private invoker current-version helpers, one scoped private SECURITY DEFINER Storage guard, four public scoped SECURITY DEFINER RPCs. Fixed empty search_path and exact-object grants; no global/default grant change. Two narrow existing-bucket policies; no bucket mutation. No existing function body rewritten.

Proof flow locks request before its own proof; it does not acquire original payment locks. Future payout must retain original payment UUID ordering before request/beneficiary/finance locks, as specified in the bank payout plan.

Isolated SQL verifies missing object, size mismatch, exact acceptance/replay, changed fingerprint, expiry, stale-after-cancel, immutable history, role denial and zero new payout journal. SQL Storage metadata fixtures are explicitly metadata simulations, not real file-byte tests.

Separate genuine Supabase Auth/PostgREST/Storage job verifies actual PNG upload and downloaded bytes/hash, concurrent exact acceptance with one row, absent-object/outsider/public denials, overwrite/delete denial, write revocation, scoped merchant reads, historic proof after actual refund and no payout journal. A revoked platform Finance role removes create/upload authority; a remaining legitimate organization membership can still have read authority.

Browser against disposable PostgreSQL/API verifies real file input→intent→failed upload→same-intent successful retry, downloaded attachment SHA256, changed-byte replacement409, unpaid withdrawal, cancellation/reload and historic proof. Browser uses the existing isolated synthetic owner session; real Auth/Storage behavior is separately proven by the native job. It is not claimed to be a production browser login or SMTP/NFC field acceptance.

Preserving rollback refuses any intent/acceptance/command history. Empty independent rollback restores exact public/private schema, all defaultACL scopes and **all pre-existing storage.objects policies**. It deletes no files or financial data. Older payment/refund/returns/holds/financial/vehicle/PIN/cron regression gates remain GREEN.

## Live rollout and postflight

Applied exactly `lib/db/migrations/0044_merchant_payout_proofs.sql` through approved Supabase migration tool; migration record **20261029071845**.

- SQL SHA256: **d0cfb98cd3859ba42a892cbc0d8e93a67395e1362e7aadc19611c73f72de7164**.
- Preserving rollback SHA256: **8e4a64a03016993c1257787df37d0aca8e6d91c2581682f5529f1059d931de58**.
- Final contract `present:true`, including Storage RLS enabled and exact new direct-grant restrictions.
- All7 live `prosrc` SHA256 match the accepted source.
- Existing4 observed financial/refund/withdrawal function bodies/OIDs/ACL/owners unchanged; existing4 observed table OIDs/RLS/ACL/owners unchanged; all old Storage policies unchanged.
- All defaultACL scopes MD5 **12effceb111a268b05bf3dd09dccdc30** unchanged.
- Withdrawal/journal/actual settlement counts remain0; new intents/acceptances/commands all0. No live synthetic file upload, bank transfer, price, user or business-row write.
- Schema cache reload notified.
- Advisors: deliberate RPC-only RLS/no-policy INFO90→93 (three new private tables); authenticated exposed SECURITY DEFINER notices141→145 (four new public RPCs). The private Storage guard is not an additional public PostgREST endpoint. Pre-existing leaked-password warning1 unchanged. These scoped RPC notices are recorded, not misrepresented as zero findings.

Live body hashes:
|Function|SHA256|
|---|---|
|`petro_private.merchant_payout_proof_version_current`|59fb962103ffea5dafa4a64cf5b8e06f8cd7385cb5cd784fc61b9086373f0226|
|`petro_private.merchant_payout_proof_current`|4c5877c88a1ba4b7d2a2899d0e23b94417434c42b5afb119f6f259a5bce114cd|
|`petro_private.can_access_merchant_payout_proof`|92720eccd7bb84503c209f75f91a981c87ba6c222588b38846fb94bf3afd99ee|
|`public.petro_merchant_payout_proof_file`|729fd87b5a347e07dc6a0227bf71ed683bfb3f99403593092be3b96ec96eee8c|
|`public.petro_merchant_payout_proofs`|e9d4102a474055339def31c4c16c69c031d6b55a9ff8a2cc461111398fc60d42|
|`public.petro_create_merchant_payout_proof`|e456536077f78a176a006665c765e65390a1ecb0468129ac22cd76dc8c94c0ea|
|`public.petro_accept_merchant_payout_proof`|7c17712468d6cc4f81b97249868f75118def4cfda6a278cc22c5a02ae278c507|

## Remaining and next exact action

Next0045 is actual authorized external bank transfer recording and full/partial financial settlement. Read existing0039 actual settlement allocation guard,0043 hold/refund helpers and0012 platform source-bank contracts, then save precise partial-remainder/lock/idempotency tests before code. Source bank registry differs from0006 beneficiary accounts. Never treat proof acceptance as paid, silently offset merchant debt or fabricate an external transfer. Update pending-claim totals separately from the outside-hold disputed partition.

Branch internal requests, warranty, role dashboards and other remaining engineering phases stay open. **Runtime web/API is not deployed:** approved current hosting destination/configuration is still unidentified. Accepted GitHub source and live additive schema are not a user-visible release.0009 remains deferred.
