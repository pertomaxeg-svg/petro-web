---
name: Supabase PostgreSQL TLS
description: TLS trust requirements for the approved Supabase PostgreSQL connection.
---

For the approved Supabase PostgreSQL connection, use the root CA certificate downloaded from that project's Database SSL settings and keep certificate verification enabled. Do not resolve certificate-chain errors by disabling TLS verification. When passing an explicit CA to `node-postgres`, remove conflicting SSL query parameters from the connection URI because URI SSL options can replace the explicit SSL configuration.

**Why:** the server's certificate chain was not trusted by Node's default CA set; Supabase documents using its downloaded root CA for full verification, which preserves server identity instead of weakening TLS.

**How to apply:** validate the connection URI belongs to project `msvgzsfzrqlrfpstthhe`, use only the project-specific PostgreSQL secret, configure the approved CA with `rejectUnauthorized: true`, and keep connection-only checks free of SQL unless the user explicitly authorizes a query.
