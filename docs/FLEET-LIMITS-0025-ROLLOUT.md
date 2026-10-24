# Fleet optional limits — 0025 rollout

Target: Supabase `msvgzsfzrqlrfpstthhe` only. Owner authorization: 23 October 2026, direct project development/migration authorization. No 0009, baseline replay, business data updates or default ACL change.

Source: `lib/db/migrations/0025_fleet_onboarding_limit_contract.sql`
SHA-256: `aa0cb88068a41d71e537c81f4a37e2af47185690c255fb0335149c33c3560ecf`.

Rollback: `lib/db/rollback/0025_fleet_onboarding_limit_contract.sql`
SHA-256: `6b719b8b2ad412ac36c9122e1aef798b93ac6fe3ec0075a7eb10ef05cafc75c4`.

## Change

Allow zero for optional monthly money and period-quantity caps. Positive existing caps retain their meaning. Daily/weekly monetary and operation limits remain enforced. Update the actual `fleet_check_usage_policy_at` evaluator (0016) and onboarding capability 2→3. No rows are rewritten and no grants are added.

## Preflight (fresh 23 October)

- Latest applied migration 0024, version `20261022061312`; 0025 absent.
- 24 default ACL scopes; fingerprint `c70fd3da5a6b0c24f1ac2bac5657bcb3`.
- Legacy status function definition MD5 `d6a0defdb1102d00b0743723db453bad`.
- Evaluator MD5 `52c7ad53ebe3206ced21d3f7c142b14a`; ACL `{postgres=X/postgres}`.
- Company summaries MD5 `b23ff715963c0d99e022de27fd021569`; ACL `{postgres=X/postgres,authenticated=X/postgres}`.
- Existing named constraints confirmed. Exact source passed previous disposable SQL/browser acceptance and guarded rollback; independent GitHub reproduction is running.

## Execution and postflight

1. Require the independent verification run to pass. Re-read migration ledger and affected definitions immediately before application.
2. Apply only this exact transactional source using the connected Supabase migration service. Keep the same source/hash in the approved runner allowlist; the connector supplies the migration ledger entry without requiring a copied DB password.
3. Verify ledger entry, capability 3, optional caps, private evaluator ACL, summaries ACL, all default ACL scopes/fingerprint and unchanged legacy function. Record actual migration version and result here.
4. Inspect security/performance advisors; classify existing intentional SECURITY DEFINER APIs by their real authorization guards rather than weakening grants automatically.

## Rollback boundary

The downgrade intentionally refuses while any policy uses a zero optional cap. Never replace those values or delete policies automatically in production. Prefer a forward fix; an operator must deliberately replace/retire affected policies before a compatible downgrade. The isolated runner tests refusal, then normalizes **disposable fixtures only** and verifies the downgrade and unchanged ACL.

Status: applied on 23 October 2026 after independent CI run 39967922067 completed successfully at commit 317d257. Migration ledger version: `20261023141941`. Fresh preflight matched the fingerprints above. Postflight confirmed capability 3, all five optional-limit constraints, unchanged function ACLs/default ACL fingerprint and unchanged legacy status definition. Evaluator definition MD5 is now `da1fe1038e7d5da245b26c230acc7e5f`; summaries definition MD5 is `8e0f5103463d54b0aa72aec327772fdf`. No business fixture writes, 0009 or other migration were executed.
