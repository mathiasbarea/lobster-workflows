# Platform Architecture

The workflows platform is split into three layers:

- `workflows/<workflow-id>/`: workflow-specific declaration and implementation
- `workflows/_shared/`: reusable helpers imported by workflows
- `workflows/_executions/`: centralized runtime state and observability

The `lobster-workflows` skill is the control plane. It bootstraps the workspace, scaffolds workflows, syncs schedules to OpenClaw cron, runs managed workflows, rebuilds daily summaries, and handles centralized approval state for managed Lobster runs.

OpenClaw cron is the scheduler, not the source of truth for workflow identity or business success. Workflows declare schedules; platform scripts project those schedules into OpenClaw cron.
