# Agentic Engineering Workflow

This report documents the reviewable, repository-safe portion of the workflow
used to build Pulse Hypr. It is an engineering control document, not a claim
that every historical line was produced by an agent or that model output was
accepted without human review.

## Evidence classification

The repository intentionally distinguishes what can be verified from what is
declared by the operator:

| Classification | Meaning | Examples in this repository |
|---|---|---|
| Repository-enforced | Executable or reviewable in source control | CI, tests, API boundaries, `AGENTS.md`, gitleaks pre-commit configuration |
| Opt-in example | Sanitized configuration that must be reviewed and enabled locally | Claude hook and MCP examples |
| Operator-declared | A working practice not independently provable from Git history | Model allocation, human review responsibility |
| Not recorded | No reliable historical measurement exists | Agent token cost, elapsed implementation time, escaped-defect count |

This avoids presenting a model roster or a configuration example as proof of
quality. The evidence is the combination of constraints, artifacts, executable
checks, and human gates.

## Delivery workflow

```text
Requirement
    |
    v
Architecture and test strategy (Opus 5) -- high-risk ambiguity --> Human decision
    |
    v
Decision-complete phase brief
    |
    v
Implementation and refactoring (GPT-5.6 Terra)
    |
    v
Automated checks + independent failure triage (Sonnet 5)
    |                                      |
    | pass                                 | defect
    v                                      v
Adversarial diff review <-------------- Minimal repair + regression test
    |
    v
Human approval of architecture, security, merge, and deployment
```

The named allocation above is the operator's current policy. Model versions can
change; the durable contract is separation of planning, implementation,
independent verification, and human authority.

### Responsibility and escalation matrix

| Role | Primary responsibility | Required output | Escalates when |
|---|---|---|---|
| Opus 5 | Architecture, decision analysis, adversarial review, complex test strategy | Phase brief, risks, acceptance criteria, review findings | Requirements conflict, an ADR must change, or risk is security/data-loss related |
| GPT-5.6 Terra | Primary implementation, focused refactoring, documentation synchronization | Minimal diff plus verification evidence | Contract is ambiguous, tests expose a design issue, or external state must change |
| Sonnet 5 | Automated test execution, failure triage, regression repair, verification | Reproduction, smallest safe fix, regression check, exact results | Failure is nondeterministic, hardware-only, security-sensitive, or requires architecture change |
| Human owner | Product intent, secrets, architecture approval, merge and deployment authority | Recorded decision or explicit approval | Never delegated for protected actions |

An agent may perform more than one role, but implementation and final review are
separate passes. A test failure is not resolved by weakening the test unless the
owner confirms that the expected behavior changed.

## Repository controls

### Shared instructions and adapters

- [`AGENTS.md`](../AGENTS.md) defines the canonical repository map, workflow,
  architecture guardrails, security boundaries, verification, and review rules.
- [`CLAUDE.md`](../CLAUDE.md) imports that canonical file, avoiding a divergent
  Claude-only policy.

This layout follows the public tool conventions: Codex loads repository-level
`AGENTS.md`, and Claude Code can import it from `CLAUDE.md`.

### Repeatable commands and automated checks

- [`scripts/verify.sh`](../scripts/verify.sh) provides one entry point for
  backend tests/type checks, web checks/build, or only changed components.
- [`/verify`](../.claude/commands/verify.md) runs the wrapper and requires exact
  pass/fail reporting.
- [`/review`](../.claude/commands/review.md) performs a read-only diff review and
  separates confirmed defects from residual risk.
- [The opt-in hook](../.claude/settings.example.json) runs changed-component
  verification asynchronously after an agent edits or writes a file. It is an
  example rather than an active repository setting so cloning the repository
  cannot silently enable command execution.
- [GitHub Actions](../.github/workflows/deploy.yml) runs backend type checking and
  tests plus dashboard checking and building. Production jobs depend on those
  verification jobs.

To enable the Claude hook, review it first and copy only the desired entries to
`.claude/settings.local.json`. Local settings must remain untracked.

### MCP boundary

[`.mcp.json.example`](../.mcp.json.example) demonstrates two deliberately
non-functional, sanitized connection patterns: an authenticated documentation
server and a read-only database server. Endpoints, executables, and credentials
come from environment variables; no reusable value is committed.

Before enabling any MCP server, the human owner reviews:

1. The server publisher, executable or endpoint, and authentication mechanism.
2. The minimum tool set and whether access can be read-only.
3. Which data can leave the workstation and how server output is logged.
4. Whether write tools, production data, or customer information are exposed.
5. How the server is disabled and its credentials are revoked.

MCP output is treated as untrusted input. MCP access does not grant authority to
deploy, merge, alter cloud resources, rotate credentials, or contact third
parties.

### Secrets and protected actions

- Root and backend `.gitignore` rules exclude plaintext environment files,
  service-account files, signing keys, and local Worker secrets.
- Root `.gitignore` also excludes local Claude settings, active MCP
  configuration, and Codex session logs; only the sanitized examples and shared
  instructions are intended for source control.
- [The pre-commit configuration](../.pre-commit-config.yaml) provides gitleaks
  scanning when a developer installs the hook. This is a local guardrail; the
  current CI workflow does not independently prove that every commit was scanned.
- Firebase web configuration is a public client identifier; Firestore and
  service-account credentials remain server-side, as described in
  [ADR-001](../backend/docs/05-DECISIONS.md#adr-001--all-client-reads-go-through-this-api-firebase-is-auth-plus-storage).
- Agents cannot push, merge, deploy, mutate cloud state, rotate credentials, or
  use protected customer data without explicit authorization. Human approval is
  required for architecture, security-sensitive changes, merge, and deployment.

## Commit-backed case study: Phase 6 web dashboard

Phase 6 provides a traceable plan-to-delivery example in the public history.

### 1. Requirement and plan

Commit [`d785b39`](https://github.com/aahadaazar/pulse-hypr-app-be/commit/d785b391cc15a8ababdd561732f978d88990f21a)
added the [Web Dashboard phase brief](PHASE-6-WEB-DASHBOARD.md). The brief records
verified starting conditions, architecture constraints, open owner decisions,
six implementation tasks, definitions of done, explicit exclusions, and the
phase exit criterion. It added 338 lines across three documentation files.

The key guardrail was ADR-001: Firebase provides browser identity, while health
data stays behind the Hono API. The plan also required honest stale/empty states,
visible-tab polling, unit conversion, eight mobile-parity metrics, and gated
Cloudflare deployment.

### 2. Implementation

Commit [`bdcfdc4`](https://github.com/aahadaazar/pulse-hypr-app-be/commit/bdcfdc48d98a6bde838660efe257c5c7ba2d59b8)
implemented the brief in 19 files with 4,079 additions:

- [`web/src/api.ts`](../web/src/api.ts) centralizes authenticated API requests,
  refreshes an expired token once, and prevents components from reading
  Firestore or calling backend endpoints directly.
- [`web/src/app.tsx`](../web/src/app.tsx) implements Google sign-in, the metric
  and sleep views, honest missing-data states, visible-tab polling, and unit
  conversion.
- [The deployment workflow](../.github/workflows/deploy.yml) verifies the Worker
  and dashboard before push-to-main deployment jobs can run.
- [`web/README.md`](../web/README.md) records local development, API selection,
  the public Firebase configuration boundary, and deployment requirements.

### 3. Independent verification evidence

The repository provides repeatable checks rather than stored chat transcripts:

| Surface | Check | Evidence |
|---|---|---|
| Backend types | `npm run typecheck` | CI job and local verification wrapper |
| Backend behavior | `npm test` | Vitest suites for frame codec, time arithmetic, merge policy, and aggregation |
| Dashboard types | `npm run check` | CI job and local verification wrapper |
| Dashboard production bundle | `npm run build` | CI job gates dashboard deployment |
| Secrets | `pre-commit` gitleaks hook | Checked-in local hook configuration; not currently a CI gate |

Historical agent transcripts, defects discovered during the implementation
loop, elapsed development time, token usage, and escaped regressions were not
recorded in the repository. This report therefore makes no numerical claim for
those measures. Future case studies should record them in the pull request or
phase closeout when disclosure is safe.

### Current verification snapshot

On 2026-08-19, `bash scripts/verify.sh all` completed successfully against the
working tree:

- Agent configuration examples parsed as valid JSON and the verification shell
  script passed syntax checking.
- Backend TypeScript checking passed; Vitest reported 3 files and 29 tests
  passed.
- Dashboard TypeScript checking passed; the Vite production build completed
  with 43 modules transformed.

This is reproducible evidence of the current checks, not retrospective proof of
which model performed historical work or how many defects it found.

## Evidence capture for future changes

Each substantial pull request should include:

- Requirement or issue link and the governing phase brief/ADR.
- Model roles used, without copying private prompts or customer context.
- Exact verification commands and results.
- Defects found during independent review and the regression test added for each.
- Human decisions or approvals required by an escalation.
- Remaining manual, hardware, security, or production validation.

Useful metrics are cycle time, automated checks executed, review defects fixed
before merge, and escaped regressions. Record `not measured` rather than
reconstructing a number after the fact.

## Suggested client response

> That is a fair observation. My public repositories have historically shown
> the resulting architecture, implementation phases, automated tests, and CI,
> but not enough of the agentic process behind them. I kept credentials, local
> MCP configuration, private prompts, and client-specific context outside Git;
> however, safe repository instructions and workflow controls can and should be
> public.
>
> My current workflow uses Opus 5 for architecture, test strategy, and high-risk
> review; GPT-5.6 Terra for implementation; and Sonnet 5 for automated test
> execution, regression analysis, and bug-resolution loops. Architecture,
> security-sensitive changes, merges, and deployments remain human-controlled.
>
> I have now documented the workflow with a tool-neutral `AGENTS.md`, a
> `CLAUDE.md` adapter, custom verification/review commands, an opt-in hook, a
> sanitized MCP example, security boundaries, and a case study tied to actual
> planning and implementation commits. Sensitive values and client information
> remain excluded.

## Public format references

- [OpenAI: custom instructions with `AGENTS.md`](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Claude Code: project memory and importing `AGENTS.md`](https://code.claude.com/docs/en/memory)
- [Claude Code: hooks](https://code.claude.com/docs/en/hooks)
- [Claude Code: MCP](https://code.claude.com/docs/en/mcp)
