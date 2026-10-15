---
name: Sanitized worktree Git context
description: Avoid targeting root main when the sanitized feature worktree metadata is incomplete.
---

When the sanitized feature directory exists without its `.git` marker, Git launched from that directory can climb to the workspace root and resolve the root `main` branch. Verify the repository root and branch before status, staging, or commits. For feature work, use the registered per-worktree `GIT_DIR` together with the matching `GIT_WORK_TREE`; do not infer the target from the shell's current directory. Avoid broad worktree repair when stale sibling worktrees are registered.

**Why:** the source files can be physically present in the branch directory while ordinary Git commands silently operate on root `main`, risking unrelated local history or staging.

**How to apply:** before any Git write, verify `git rev-parse --show-toplevel` and the expected ref. If they disagree, stop using ordinary Git in that directory and select the exact registered worktree metadata. Never change remotes or push until the expected branch is confirmed.
