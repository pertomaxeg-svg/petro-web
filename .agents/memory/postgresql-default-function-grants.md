---
name: PostgreSQL default function grants
description: Avoid cross-schema default ACL changes in Pertomax database migrations.
---

For Pertomax migrations, restrict ACL changes to the explicit application tables and functions under review. Do not modify `ALTER DEFAULT PRIVILEGES` unless the user separately approves a scope that has been checked across every affected schema. PostgreSQL's global `PUBLIC EXECUTE` default cannot be removed by a schema-scoped revoke; removing it globally changes future function ACLs for that owner across all schemas, including extension/Supabase schemas. Keep existing baseline defaults unchanged and describe them as a residual risk rather than implying they are safe.

**Why:** The user limited DB-02 to named Pertomax resources and explicitly rejected a broad default-privilege change that could affect extension or Supabase functions.

**How to apply:** Use exact object-level `REVOKE`/`GRANT` for reviewed resources. In local tests, snapshot all `pg_default_acl` rows before and after the migration and assert equality across schemas; report the existing default ACL policy separately for future objects.
