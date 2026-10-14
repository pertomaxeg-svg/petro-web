---
name: GitHub SSH key diagnosis
description: Diagnose repository-scoped deploy-key failures before asking for credential changes.
---

Before requesting a new key, inspect the repository's effective `core.sshCommand` and the helper it invokes. Distinguish a Secret missing from the Git process, a local key parsing/formatting failure, a GitHub public-key rejection, and a strict host-key verification failure. A Secret can be present and valid while an older helper rejects its encoding before GitHub receives an authentication attempt.

**Why:** Replacing credentials unnecessarily wastes user effort and can break a working repository-specific deploy-key setup.

**How to apply:** Keep the helper and SSH configuration repository-scoped, load the Secret at each Git invocation, validate temporary key material without printing it, preserve strict host-key checking, and confirm `git ls-remote` before attempting a push.
