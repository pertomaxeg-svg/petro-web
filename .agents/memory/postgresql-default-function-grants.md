---
name: PostgreSQL default function grants
description: PostgreSQL default ACL behavior for function EXECUTE and schema-scoped revocations.
---

Do not assume `ALTER DEFAULT PRIVILEGES ... IN SCHEMA ... REVOKE EXECUTE FROM PUBLIC` removes PostgreSQL's global default `PUBLIC EXECUTE` on newly created functions. Removing the default globally for a role affects future functions created by that role in every schema, not just `public`; review extension and other schema consumers before proposing or applying that broader change. Test effective permissions by creating disposable objects under each relevant owner and checking `has_function_privilege`, `has_table_privilege`, and `has_sequence_privilege`.

**Why:** A PostgreSQL 17 local probe for this project showed `anon` and `authenticated` still inherited function execution after a schema-scoped revoke; the global revoke worked but had cross-schema scope.

**How to apply:** State the global impact explicitly in any permission migration. If that scope is not approved, retain explicit per-function ACL checks in future migrations and report the residual default instead of claiming schema-local hardening succeeded.
