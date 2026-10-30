# Pertomax EG — build, release and recovery

## Current release boundary

Development changes are committed directly to `pertomaxeg-svg/petro-web`, branch `pertomax-central-orgs-20261015`. Database changes target only Supabase `msvgzsfzrqlrfpstthhe`. GitHub Actions performs independent builds and isolated acceptance; no Replit agent or runtime is required for verification.

A production web/API hosting destination and DNS mapping have not been identified or verified. The repository and Supabase schema being updated does not mean the web/API release is deployed. Do not create an unrelated host, publish a frontend whose API is disconnected, or report a production release from a health response alone.

## Build contract

The verified toolchain is Node 24, pnpm 11.25.0, PostgreSQL 17 and Chrome. GitHub Actions runs:

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
node --test artifacts/api-server/src/lib/*.test.mjs lib/db/rebuild/normalize-pg-dump.test.mjs
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/pertomax-eg-web run build
bash lib/db/rebuild/run-local-test.sh
```

Web build inputs: `BASE_PATH=/`, a positive `PORT` (CI uses 25467). Output: `artifacts/pertomax-eg-web/dist/public`. API output: `artifacts/api-server/dist/index.mjs` and generated worker/source-map files. The API bundle externalizes ExcelJS and other optional native/runtime packages: the bare bundle is not a verified standalone deployment. Retain required production dependencies from the tested checkout; do not substitute the Vite development server for production hosting.

Feature changes are verified through the existing pull request; main updates are verified on push. Keep a pull request open for a development branch, or use the manual workflow trigger. This avoids running the same expensive database/browser/real-service suites twice for every commit.

## Runtime configuration

| Setting | Required behavior |
| --- | --- |
| `NODE_ENV` | `production`; secure HTTP-only Auth cookies |
| `PORT` | Positive port supplied by the approved API runtime |
| `SUPABASE_URL` | Exactly `https://msvgzsfzrqlrfpstthhe.supabase.co` |
| `SUPABASE_ANON_KEY` | Approved project's publishable/anon key; never a service-role/secret key |
| `SUPABASE_DB_URL` | Approved project direct/pooler PostgreSQL URL with SSL; server secret only |
| `FLEET_DRIVER_PAIR_PIN_ENCRYPTION_KEY_V<n>` | 32 random bytes encoded as base64, server secret only; preserve versions needed to decrypt existing PIN ciphertext |

The DB connector verifies the approved host/project, uses the bundled root CA with `rejectUnauthorized: true`, and has a ten-second connection timeout. Do not bypass TLS verification or expose the DB URL or PIN encryption keys in frontend variables, logs, screenshots, public Actions output, commits or artifacts. Runtime key presence/rotation has not been verified in production.

Serve the built frontend with SPA fallback for browser routes. Route `/api/*` to the Express API before any HTML fallback. Keep frontend, callback and API on the approved HTTPS origin so existing HTTP-only SameSite=Lax cookies work. The API trusts one reverse-proxy hop: the selected host must sanitize forwarded headers and prevent untrusted direct access around that proxy. Configure the actual Supabase callback allowlist for that origin; no production domain is invented here.

Owner bootstrap variables must remain absent after initialization. Never use a new bootstrap owner or an Auth bypass to test a protected release.

## Database release

Use only reviewed additive migrations with exact source SHA-256, rollback source, independent SQL/API/browser evidence and fresh live preflight. Use `lib/db/scripts/apply-approved-admin-migrations.mjs` for its explicit allowlist contract, or the approved Supabase migration connector with the exact reviewed source. Do not replay the baseline or prior migrations. `0009` stays deferred.

Before/after: check ledger/version, affected function definitions and ACL, all 24 default ACL scopes and the legacy status RPC fingerprint. Never apply fixtures or synthetic acceptance data to production. Rollout documents record each migration's hashes and evidence.

## Release acceptance and recovery

- Deploy an immutable tested commit to the identified project runtime; record that commit, actual release URL and configuration presence without values.
- Confirm public pages/assets and deep-route reloads; `/api/healthz` alone proves neither authenticated access nor database readiness.
- Use an authorized isolated environment for create/edit/read/reload, role denial, PIN privacy and actual private image upload/download. Production user balances, prices and transactions are not test fixtures.
- Verify email delivery and callback behavior with an approved test mailbox; isolated generated-link confirmation does not prove SMTP delivery.
- Rehearse backup/restore and previous-release recovery against isolated resources before claiming disaster-recovery readiness.
- Revert web/API by selecting the previous tested release. Database rollback follows its specific reviewed document and compatibility check; additive columns/data are not automatically deleted. Preserve production audit and financial history.

Production hosting, DNS/TLS, runtime secret readiness, SMTP delivery, physical NFC and backup/restore remain explicit release gates. Their absence does not block independent code, schema review or GitHub-isolated tests.
