# Fuel tank authorization guard — 0026

Target: Supabase `msvgzsfzrqlrfpstthhe` only; 0009 remains deferred.

Source SHA-256: `677a2d36a27d5fc07479d80066c968c75ab38c4558ad10fcf471513ba4150c4a`.
Rollback SHA-256: `85fe3f5053cecb4d944a93d0ea687956d6b0d7e7c5e24f2dda76877583aa058e`.

## Behavior and acceptance

The private policy evaluator reads the actual vehicle tank capacity and rejects fuel quantity above it, even when a client bypasses the form or a policy permits more. Exact decimal equality remains valid. Only fuel is affected; existing vehicles without a recorded capacity retain their published policy caps. New onboarding already requires a positive tank capacity when enabling fuel.

TDD RED: independent CI run 39969027525 on 8cb5e01 failed at the intended assertion: 2.501 litres was allowed for a stored 2.5 litre tank. Before the regression assertion, browser/API/finance tests passed. GREEN is required before any live application.

The migration replaces only the existing evaluator definition, preserving SECURITY DEFINER, fixed search_path and its private ACL. No grants, schema exposure, table rewrites or business records. The reservation RPC already locks the vehicle row before evaluating policy. The isolated test verifies the boundary and restores fixture changes in a rolled-back transaction; the runner checks unchanged default ACL and exact evaluator definition/ACL restoration on rollback.

Generated via Supabase CLI `migration new fleet_fuel_tank_capacity_guard`, then moved to this repository's numbered migration directory. CLI cache is excluded from commits.

## Live procedure

After full CI GREEN: freshly confirm 0025 is latest, source hashes and evaluator MD5 `da1fe1038e7d5da245b26c230acc7e5f`; default ACL 24 scopes/hash `c70fd3da5a6b0c24f1ac2bac5657bcb3`; evaluator ACL `{postgres=X/postgres}`; legacy status MD5 `d6a0defdb1102d00b0743723db453bad`. Apply this exact transactional source alone, then confirm ledger/guard and unchanged ACL/legacy. Rollback restores the prior evaluator without deleting or rewriting user data, but removes the capacity enforcement, so prefer a forward correction.

Status: applied on 23 October 2026 after full independent CI GREEN (run 39969626095, commit 6e404fc), including the exact evaluator/ACL rollback. Migration version `20261023142953`. Fresh preflight matched all fingerprints above. Postflight: guard and actual capacity read present; evaluator MD5 `3aeed14fd6c17f4280eee5ed68b68097`; private ACL, 24 default ACL scopes/fingerprint and legacy status definition unchanged. Security advisors were read after application; existing RLS-without-direct-policies and privileged RPC findings remain subject to the existing scoped-RPC model review. No business records were written.
