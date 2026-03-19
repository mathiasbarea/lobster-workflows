---
name: lobster-workflows
description: "Create and manage Lobster-based workflow workspaces, shared workflow libraries, workflow scaffolds, OpenClaw cron schedule sync, execution metrics, and approval workflows under workspace/workflows. Use when a user wants to bootstrap a workflows platform, create a new workflow, standardize workflow structure, manage scheduling and observability, check pending workflow approvals, or inspect Telegram approval callbacks for managed Lobster workflows, including messages like `/lwf ap:<token>`, `/lwf rj:<token>`, `callback_data: /lwf ap:<token>`, `callback_data: /lwf rj:<token>`, `lwf:ap:<token>`, or `lwf:rj:<token>`."
user-invocable: true
---

# Lobster Workflows

Use this skill when working on a workspace-level `workflows/` platform backed by Lobster and OpenClaw cron.

## What This Skill Owns

- Bootstrap `workflows/`, `workflows/_shared`, and `workflows/_executions`
- Scaffold new workflows with `workflow.config.js`, runner, Lobster file, and tests
- Provide platform scripts for schedule sync, managed execution, and execution summaries

## Authoring Protocol

When the user asks to create a new workflow, follow this order:

1. Ensure the workspace platform exists
2. Gather the minimum workflow spec
3. Scaffold the workflow
4. Implement the workflow logic and tests
5. Add schedules only if the user asked for them or the spec clearly requires them
6. Sync schedules after the workflow config is ready
7. Validate the workflow with tests or a safe smoke run

Do not skip the spec-gathering step unless the missing details are low-risk and you can make a defensible default assumption.

## Minimum Workflow Spec

Before creating a new workflow, make sure you know:

- stable `workflowId`
- workflow goal
- workflow phases or steps
- expected final result
- whether it needs a schedule
- if scheduled: schedule frequency, timezone, and whether it should count toward expected runs
- workflow inputs or default runtime values
- side effects or external systems touched
- what success means

If any of those are missing and they materially affect implementation, ask concise follow-up questions.

Read `references/new-workflow-requirements.md` when authoring a workflow from a user request.

## Commands

Use the bundled scripts directly:

```bash
node scripts/bootstrap-workspace.js --workspace-root <path>
node scripts/new-workflow.js --workspace-root <path> --id <workflow-id>
node scripts/run-workflow.js --workspace-root <path> --workflow <workflow-id>
node scripts/list-pending-approvals.js --workspace-root <path>
node scripts/resume-workflow.js --workspace-root <path> --callback-data '/lwf ap:<token>'
node scripts/sync-schedules.js --workspace-root <path> [--workflow <workflow-id>] [--sync-backend auto|cli|gateway] [--dry-run]
node scripts/doctor.js --workspace-root <path> [--workflow <workflow-id>] [--fix]
node scripts/rebuild-daily-summary.js --workspace-root <path> --date YYYY-MM-DD
```

## Approvals

- Managed Lobster workflows may pause with status `awaiting_approval`
- Approval decisions are Telegram-only and should be resolved from inline button callbacks via the optional `./plugin`
- Pending approvals may be queried from any chat/channel by using `list-pending-approvals.js`
- Configure `approvals.telegram.approvers` with numeric Telegram user IDs for authorization
- Approval delivery is DM-only in this skill
- Telegram inline buttons should emit the plugin command `/lwf ap:<token>` or `/lwf rj:<token>`
- The skill runtime stores approval state and provides `resume-workflow.js`; the optional plugin handles Telegram button routing before the message reaches the model
- Do not infer approval or rejection from free-form chat text; use the callback payload or explicit Telegram-only path

## Rules

- `workflows/_shared` is only for reusable helpers imported by workflows
- Global workflow platform logic belongs in this skill, not in `workflows/_shared`
- Runtime state belongs in `workflows/_executions`
- Do not initialize git inside `workflows/`; only the skill folder itself may own its own git repo
- Use `node scripts/new-workflow.js` for the initial scaffold instead of hand-creating the base structure
- Put workflow tests in `workflows/<workflow-id>/tests/`
- Keep `workflow.config.js` declarative
- The workflow defines identity, runtime, schedules, result, and observability
- The skill runtime writes run records and latest results; the workflow does not write `_executions` directly
- Any task that creates, edits, enables, disables, or deletes a schedule in `workflow.config.js` must run `node scripts/sync-schedules.js --workspace-root <path> [--workflow <workflow-id>]` before completion
- Prefer the default `--sync-backend auto`; it retries through the gateway if the CLI transport fails
- Use `--dry-run` when you need a deterministic reconciliation plan and actionable remediation commands without mutating cron state
- If schedule sync returns `status: "recovery-only"`, no cron mutation happened; use `recovery.retryCommands` or `operations[].remediation` instead of claiming the sync succeeded
- If schedule drift is suspected or the user asks for a health check, run `node scripts/doctor.js --workspace-root <path>` and use `--fix` when the user wants reconciliation applied automatically

## Workflow Creation Checklist

When building a real workflow after scaffolding:

- replace the placeholder action with the requested phases
- update `workflow.config.js` so `runtime.defaultAction` and `result.extractor` match the real workflow
- if `schedules` changed in any way, rerun `sync-schedules.js` before finishing
- write or adapt `README.md` and `CONTRACT.md`
- add at least one smoke test plus targeted tests for fragile phases
- prefer `_shared` helpers only when they are genuinely workflow-agnostic
- keep platform logic out of the workflow folder

Read `references/testing-rules.md` when adding or reviewing tests.
Read `references/shared-modules-catalog.md` before adding new helpers to `_shared`.
Read `references/schedule-and-result-rules.md` when defining schedules or the canonical workflow result.

## References

- Read `references/platform-architecture.md` when changing the workspace layout or responsibilities
- Read `references/workflow-config.md` when changing scaffolded `workflow.config.js`
- Read `references/new-workflow-requirements.md` when turning a user request into a workflow spec
- Read `references/shared-modules-catalog.md` when deciding whether code belongs in `_shared`
- Read `references/testing-rules.md` when deciding what tests a workflow must have
- Read `references/schedule-and-result-rules.md` when defining schedules, expected runs, or canonical result payloads
