---
name: Approved migration runner
description: Requirements for safe use of the project's allowlisted Supabase migration runner.
---

SQL migration sources must begin with `BEGIN;` and end with `COMMIT;`; place comments after the opening wrapper because the runner validates the source boundaries. Probes for not-yet-installed functions must use `to_regprocedure` and handle absence as a false state instead of casting to `regprocedure`. Whenever migration SQL changes before application, update its allowlisted SHA-256 and rollback plan together.

**Why:** strict preflight failures are preferable to ambiguous migration state, but a missing object should be reported as an unapplied migration rather than causing a cast error. A stale source hash or rollback document can otherwise misrepresent what was reviewed.

**How to apply:** before an approved project migration, test the source on the disposable PostgreSQL rebuild, run the explicit target's dry-run and affected-resource/ACL checks, verify the rollback plan hash, then apply only the selected migration.
