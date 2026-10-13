---
name: Pertomax project boundaries
description: Durable isolation and data-safety rules for the Pertomax EG project.
---

Pertomax EG is isolated from the user's other Replit projects, GitHub repositories, databases, and VPS instances. Work only in this project. Its approved code repository is `https://github.com/pertomaxeg-svg/petro-web`, and its approved Supabase project is `msvgzsfzrqlrfpstthhe` at `https://msvgzsfzrqlrfpstthhe.supabase.co`. Do not change shared account integrations, copy settings or secrets from another project, or deploy/connect to a VPS. Keep secrets out of source control. The user reports that the Supabase foundation already contains nine tables for accounts, organizations, branches, permissions, audit, plans, and plan versions, all with RLS enabled; do not recreate them, weaken anon access, or disable RLS.

**Why:** the user explicitly requires strict separation between Pertomax EG and their other projects, and confirmed the existing database foundation must be preserved.

**How to apply:** before any remote or database operation, verify the target matches the approved repository/project. Preserve existing data and protections; use only the public key for public Auth connectivity checks, and never use a service-role key for readiness probes.
