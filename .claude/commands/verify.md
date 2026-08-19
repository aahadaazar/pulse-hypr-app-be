---
description: Run repository checks for all or changed components and report exact results
argument-hint: [changed|all|backend|web]
allowed-tools: Bash(bash scripts/verify.sh *)
---

Run `bash scripts/verify.sh ${ARGUMENTS:-changed}` from the repository root.

Report each check as passed, failed, or not run. If a check fails, identify the
first actionable error and do not describe verification as successful.
