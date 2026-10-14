---
name: Supabase Auth test accounts
description: Safe approach to sign-up-based end-to-end testing in the Pertomax Supabase project.
---

As of October 14, 2026, the approved Supabase project's email provider and sign-ups are enabled, but email auto-confirmation is disabled. Supabase Auth rejects `.invalid` test-email addresses, and a successful sign-up may send a confirmation email.

**Why:** end-to-end auth testing must not send unexpected mail to real people or claim a confirmed login without access to the confirmation mailbox.

**How to apply:** recheck public Auth settings before signup-based tests. If confirmation is required and there is no explicitly authorized test mailbox, stop account-creation tests and report them as blocked; do not bypass confirmation or change Auth settings to make tests pass.
