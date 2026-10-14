# Pertomax EG

Backend foundation for the Pertomax EG project, prepared to connect securely to its Supabase database.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080 in this Repl)
- The web artifact runs through `artifacts/pertomax-eg-web: web` (port 25467).
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm --filter @workspace/api-server run build` — build the API
- `PORT=25467 BASE_PATH=/ pnpm --filter @workspace/pertomax-eg-web run build` — build the web artifact
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- Required secret: `SUPABASE_DB_URL` — PostgreSQL connection URI for the approved Supabase project; do not use Replit-managed `DATABASE_URL`.
- Supabase Auth connection: `SUPABASE_URL` and `SUPABASE_ANON_KEY` in Replit Secrets. The optional owner-bootstrap secrets are only for the initial, explicitly authorized setup; remove them after successful initialization and never restore them as a shortcut.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/pertomax-eg-web/` — Arabic RTL web application.
- `artifacts/api-server/` — shared Express API and Supabase readiness check.
- `lib/api-spec/openapi.yaml` — source of truth for API contracts.
- `lib/db/` — Drizzle connection configured only for the approved Supabase PostgreSQL secret.

## Architecture decisions

- Supabase Auth and data access run through the API server using HttpOnly cookies; the public key is never sent to a browser.
- Use Supabase Auth as the application's identity provider. Do not use Clerk for this app, but leave shared Replit integrations and other projects untouched.
- Sign-up and sign-in use username and password only. A real email is required for confirmation and recovery, but is never accepted as the login identifier; do not offer Google or other social sign-in.
- `petro_profiles.user_id` links to Supabase `auth.users`; do not join or migrate identities from Clerk.
- Supabase service/readiness checks are read-only. Apply schema changes only when explicitly authorized, through idempotent migrations that preserve existing tables and RLS.
- New accounts remain pending until a trusted administrator assigns access. Owner setup requires a confirmed account whose username matches the private allowlist, a private bootstrap token, no previous owner, and a one-use audit record; never auto-promote the first account.
- Keep full PostgreSQL TLS verification enabled with the approved Supabase root CA.

## Execution constraints

- For the active Pertomax EG task, use only the currently available Free mode. Do not select Power or Max, buy credits, upgrade a subscription, or bypass a usage limit.
- A message stating a model preference is not approval in a model-selection dialog. If the UI requires a model choice, stop and clearly ask the user to select Free themselves.
- If Free usage is exhausted, stop. Do not assume work resumes automatically; on or after the scheduled review date, first verify that Free capacity is available. The scheduled review is October 29, 2026.
- Work in ordered, testable steps. Record what was completed, what remains, and test results. Do not call a phase complete until its relevant checks pass.
- On resumption, resolve and test the web/API preview runtime first, then verify the actual approved Supabase connection and review its schema read-only, then continue Phase 1.

## Project boundaries and data rules

- Work only in this Pertomax EG Repl. Do not open or modify the user's two other Replit projects.
- The only approved GitHub destination is `https://github.com/pertomaxeg-svg/petro-web`. Before synchronizing, verify that this Repl's active GitHub destination matches exactly. If an existing remote points elsewhere, do not use, replace, or detach it; report the conflict. If no remote exists, configure only this exact user-approved destination after confirming it is accessible. After testing, save changes without force-pushing, rewriting history, auto-merging, or triggering deployment.
- Preserve all other GitHub, database, and VPS connections. Do not open or modify the user's two other Replit projects, change shared account connections/settings, migrate databases, or connect to a VPS.
- The only approved external database for this phase is Supabase project `msvgzsfzrqlrfpstthhe` (`https://msvgzsfzrqlrfpstthhe.supabase.co`). Verify the active connection's project reference and review its existing schema before querying or changing it. If the connection cannot be confirmed as this project, leave it untouched and report the conflict.
- Do not change account-wide Replit settings. Development only; do not publish or deploy.
- GitHub uploads for this Repl use the repository-specific `PERTOMAX_PETROWEB_DEPLOY_KEY` Replit Secret through `scripts/pertomax-github-ssh`, selected by this repository's local `core.sshCommand` setting. The helper reads the Secret at each Git invocation and accepts raw OpenSSH private-key text (including flattened line breaks) or Base64-encoded private-key text. It uses a mode-`0600` temporary key outside the workspace, removes it on exit, and keeps `StrictHostKeyChecking=yes` against the verified GitHub host-key file in this repository's `.git` directory. Never print the Secret, place it in source files, change the remote, or force-push. Before pushing, verify `origin` is exactly `git@github.com:pertomaxeg-svg/petro-web.git`, run `git ls-remote origin refs/heads/main`, and scan all unpushed history for secrets.
- The interface and user-facing messages are Arabic, RTL, responsive, and use Egyptian pounds (EGP).
- The official platform logo is the user-provided Petro Max EG artwork. Use the original lockup for prominent brand placements and its unaltered symbol crop for compact headers and browser icons; do not substitute the previous generated mark.
- New accounts remain pending until a trusted administrator assigns access. Never grant platform ownership to the first user or create default credentials.
- Tenant and branch data must be limited to the authenticated user's explicit memberships and permissions.
- Phase one covers authentication, access assignment, organizations, branches, invitations, account status, and administrative audit history. Do not present wallets, payments, or settlements as implemented.
- Keep this phase order: (1) runtime and connections, (2) identity and account permissions, (3) dashboards for the platform owner and organizations/branches, (4) vehicles, drivers, and chips, (5) catalog, services, and inventory, (6) finance, wallets, and settlements, (7) reports, support, and integration tests, (8) worker apps as the final build phase. Do not start later phases before their turn.
- Current user-provided commercial rules: annual company plans are EGP 500, 750, and 1,000 per vehicle; chip issuance is EGP 100; service-provider default subscription is EGP 5,000 per branch/year; stations join free with no commission. Price changes must create a new version and preserve prior prices.

## Product

Pertomax EG is an Egyptian platform for managing companies, stations, service providers, branches, access approvals, and versioned annual plans. Organization data is isolated by membership and branch permissions.

- Sign-in requirement: username and password only. Email is for confirmation and recovery, never a login alternative. Do not offer Google or other social sign-in buttons. Do not call the flow fully tested until a verified account is available for end-to-end tests.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
