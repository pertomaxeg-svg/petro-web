# Pertomax EG

Backend foundation for the Pertomax EG project, prepared to connect securely to its Supabase database.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Supabase connection: `SUPABASE_URL` and `SUPABASE_ANON_KEY` (store the key in Replit Secrets)

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
- `lib/db/` — existing Replit PostgreSQL/Drizzle connection; preserve it.

## Architecture decisions

- Supabase is contacted from the API server; its API key is never sent to a browser.
- The initial connection check is read-only and does not create or modify database tables.

## Project boundaries and data rules

- Work only in this Pertomax EG Repl. Do not open or modify the user's two other Replit projects.
- The only approved GitHub destination is `https://github.com/pertomaxeg-svg/petro-web`. Before synchronizing, verify that this Repl's active GitHub destination matches exactly. If an existing remote points elsewhere, do not use, replace, or detach it; report the conflict. If no remote exists, configure only this exact user-approved destination after confirming it is accessible. After testing, save changes without force-pushing, rewriting history, auto-merging, or triggering deployment.
- Preserve all other GitHub, database, and VPS connections. Do not open or modify the user's two other Replit projects, change shared account connections/settings, migrate databases, or connect to a VPS.
- The only approved external database for this phase is Supabase project `msvgzsfzrqlrfpstthhe` (`https://msvgzsfzrqlrfpstthhe.supabase.co`). Verify the active connection's project reference and review its existing schema before querying or changing it. If the connection cannot be confirmed as this project, leave it untouched and report the conflict.
- Do not change account-wide Replit settings. Development only; do not publish or deploy.
- The interface and user-facing messages are Arabic, RTL, responsive, and use Egyptian pounds (EGP).
- New accounts remain pending until a trusted administrator assigns access. Never grant platform ownership to the first user or create default credentials.
- Tenant and branch data must be limited to the authenticated user's explicit memberships and permissions.
- Phase one covers authentication, access assignment, organizations, branches, plan approval/status, versioned pricing, and administrative audit history. Do not present wallets, payments, or settlements as implemented.
- Keep later phases on the roadmap only: companies, vehicles, drivers, chips, service catalog, services, prepaid wallet, and monthly settlements.
- Current user-provided commercial rules: annual company plans are EGP 500, 750, and 1,000 per vehicle; chip issuance is EGP 100; service-provider default subscription is EGP 5,000 per branch/year; stations join free with no commission. Price changes must create a new version and preserve prior prices.

## Product

Pertomax EG is an Egyptian platform for managing companies, stations, service providers, branches, access approvals, and versioned annual plans. Organization data is isolated by membership and branch permissions.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

_Populate as you build — sharp edges, "always run X before Y" rules._

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
