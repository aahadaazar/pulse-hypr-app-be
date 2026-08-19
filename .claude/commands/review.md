---
description: Review the current diff for correctness, security, tests, and scope
allowed-tools: Read, Glob, Grep, Bash(git status:*), Bash(git diff:*), Bash(bash scripts/verify.sh changed)
---

Perform a read-only review of the current worktree diff using the review rules
in `AGENTS.md`.

1. Read the relevant requirements, ADRs, and contracts.
2. Inspect staged and unstaged changes without modifying files.
3. Run `bash scripts/verify.sh changed` when dependencies are available.
4. Report findings in severity order with file references. Separate confirmed
   defects from risks or optional improvements.
5. If there are no findings, say so and list residual risks or checks not run.
