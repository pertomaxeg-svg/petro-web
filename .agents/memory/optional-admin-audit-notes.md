---
name: Optional admin audit notes
description: How to make ordinary admin edits easier while preserving the existing database audit contract.
---

For routine plan and catalog creation or draft edits, a user-entered audit note can be optional. The server should record a neutral description of the administrative action when the user leaves it blank, preserving the existing non-null database audit contract. Publishing, cancellation, status changes, review decisions, and destructive actions still require an explicit reason.

**Why:** This keeps routine editing simple without applying an unapproved live-schema change or weakening audit requirements for sensitive actions.

**How to apply:** Use the neutral server default only for routine edits; enforce explicit reasons in both the API and database for sensitive actions. Do not imply the default is a business justification, and do not loosen the live constraint unless separately approved.
