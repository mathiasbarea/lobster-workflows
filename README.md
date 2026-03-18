# lobster-workflows

Human-facing guide for the `lobster-workflows` skill.

This skill helps you build and operate a workspace-level workflows platform under `workspace/workflows/`.

It is designed for teams or individuals who want:

- a consistent structure for Lobster workflows
- shared helpers for multiple workflows
- centralized execution records and daily metrics
- schedule sync to OpenClaw cron

## Requirements

- Node.js available on the system
- OpenClaw installed and configured if you want to sync schedules to cron
- Lobster installed and available on `PATH` if you want to run `.lobster` entrypoints or any workflow with `runnerType: "lobster"`

Most platform scripts work without invoking Lobster directly, but the platform is designed around Lobster-capable workflows.

## What This Skill Creates

The skill manages three layers:

```text
workspace/
  workflows/
    <workflow-id>/
    _shared/
    _executions/
```

### `workflows/<workflow-id>/`

This is where each workflow lives.

Each managed workflow should contain:

- `workflow.config.js`
- `README.md`
- `CONTRACT.md`
- a canonical runner such as `run-workflow.js`
- workflow implementation files
- tests

### `workflows/_shared/`

This is for reusable code that workflows can import directly.

Examples:

- filesystem helpers
- process helpers
- OpenClaw client helpers
- envelope / error contracts

Do not put workflow-specific business logic here.

### `workflows/_executions/`

This is centralized runtime state.

It stores:

- run records
- daily summaries
- latest result per workflow
- schedule snapshots
- cron sync state

## Mental Model

This skill is the control plane for the workflows platform.

The workflow itself defines:

- identity
- runtime
- schedules
- result extraction
- observability rules

The skill handles:

- workspace bootstrap
- workflow scaffolding
- managed execution
- schedule sync to OpenClaw cron
- execution persistence
- daily metrics rebuilding

## Lifecycle

The normal lifecycle looks like this:

1. Bootstrap the workspace
2. Create a workflow scaffold
3. Implement the workflow logic
4. Define schedules in `workflow.config.js`
5. Sync schedules to OpenClaw cron
6. Run workflows manually or from cron
7. Rebuild daily summaries

## Quick Start

### 1. Bootstrap the workspace

```bash
node scripts/bootstrap-workspace.js --workspace-root /path/to/workspace
```

This creates:

- `workflows/`
- `workflows/_shared/`
- `workflows/_executions/`

It is idempotent. Running it again is safe.

### 2. Create a new workflow

```bash
node scripts/new-workflow.js --workspace-root /path/to/workspace --id my-workflow
```

This creates a workflow scaffold with:

- `workflow.config.js`
- `README.md`
- `CONTRACT.md`
- a Lobster file
- a Node runner
- a starter action
- a smoke test

### 3. Run a workflow manually

```bash
node scripts/run-workflow.js --workspace-root /path/to/workspace --workflow my-workflow
```

This runs the workflow through the managed runtime and writes execution records into `_executions`.

### 4. Sync schedules to OpenClaw cron

```bash
node scripts/sync-schedules.js --workspace-root /path/to/workspace
```

Or for one workflow:

```bash
node scripts/sync-schedules.js --workspace-root /path/to/workspace --workflow my-workflow
```

### 5. Rebuild the daily summary

```bash
node scripts/rebuild-daily-summary.js --workspace-root /path/to/workspace --date 2026-03-18
```

## `workflow.config.js`

Every managed workflow exposes one canonical machine-readable file:

- `identity`
- `runtime`
- `schedules`
- `result`
- `observability`

This file should stay declarative.

It should not:

- write files
- call APIs
- depend on current time
- store runtime state such as cron `jobId`s or metrics

## How Managed Execution Works

When you run:

```bash
node scripts/run-workflow.js --workspace-root <workspace> --workflow <workflow-id>
```

the skill does this:

1. Loads `workflow.config.js`
2. Resolves the workflow entrypoint
3. Merges `runtime.defaultInputs` with any provided input
4. Writes an initial run record with status `running`
5. Executes the workflow
6. Parses the workflow JSON envelope
7. Evaluates success using `observability.successCondition`
8. Extracts the canonical result using `result.extractor`
9. Writes the final run record
10. Updates `latestResult` on success

This means result persistence is handled by the skill runtime, not by a workflow step.

## How Scheduling Works

Workflows declare schedules in `workflow.config.js`.

OpenClaw cron is the scheduler, but it is not the source of truth for workflow identity.

The source of truth is the workflow config.

`sync-schedules.js` reads workflow schedules and projects them into OpenClaw cron jobs.

Managed cron jobs are named like this:

```text
lobster-workflows::<workflowId>::<scheduleId>
```

The current implementation uses the official `openclaw cron ...` CLI to list, add, edit, and disable jobs.

## Where Results and Metrics Are Written

### Run records

Each managed execution writes a run record under:

```text
workflows/_executions/runs/YYYY-MM-DD/<workflow-id>/<execution-id>.json
```

### Latest result

The latest successful result is written under:

```text
workflows/_executions/latest/<workflow-id>.json
```

### Daily summary

The daily summary is written under:

```text
workflows/_executions/daily/YYYY-MM-DD.json
```

### Schedule snapshot

Expected schedule occurrences for a given date are written under:

```text
workflows/_executions/schedules/YYYY-MM-DD.json
```

### Sync state

The cron sync state for each workflow is written under:

```text
workflows/_executions/sync/<workflow-id>.json
```

## Daily Metrics

The summary builder calculates:

- `expectedRuns`
- `expectedWorkflows`
- `startedRuns`
- `startedWorkflows`
- `successfulRuns`
- `failedRuns`
- `abandonedRuns`
- `missedRuns`
- `manualRuns`

It also stores per-workflow summaries and `latestResult`.

## Important Rules

- Put reusable runtime helpers in `workflows/_shared`
- Put centralized state in `workflows/_executions`
- Keep platform logic in this skill, not in `_shared`
- Do not initialize git inside `workspace/workflows`
- The skill folder itself may have its own git repo

## Notes for Future Users

- `SKILL.md` is for Codex
- this `README.md` is for humans
- use `workflow.config.js` as the stable contract between your workflow and the platform
- use the managed runner if you want `_executions` to be updated
- running a workflow entrypoint directly does not automatically give you platform observability unless it is executed through `scripts/run-workflow.js`

## Related Files

- [SKILL.md](./SKILL.md)
- [references/platform-architecture.md](./references/platform-architecture.md)
- [references/workflow-config.md](./references/workflow-config.md)
