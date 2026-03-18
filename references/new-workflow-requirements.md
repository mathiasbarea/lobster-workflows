# New Workflow Requirements

Use this reference when a user asks to create a new workflow.

## Goal

Turn an ambiguous request such as "create a workflow that does X" into a spec that is detailed enough to scaffold and implement a real managed workflow.

## Required Inputs

Before implementation, make sure the following are known:

- `workflowId`
  - stable slug
  - should match the folder name
- workflow goal
  - one or two sentences explaining what the workflow exists to achieve
- phases
  - ordered list of steps the workflow should run
- final result
  - what the workflow should return as its canonical result
- runtime defaults
  - any default inputs or paths the workflow needs
- success condition
  - what counts as a successful run

## Scheduling Inputs

Only required if the workflow should be scheduled.

- whether the workflow is scheduled or manual-only
- schedule kind
  - `cron`
  - `every`
  - `at`
- frequency or exact timing
- timezone
- whether the schedule should count toward expected daily runs

## External Side Effects

Clarify these before writing the workflow:

- which files or directories it writes
- whether it calls external tools
- whether it uploads, sends, posts, or mutates remote systems
- whether retries are safe

## Questions To Ask When The Spec Is Incomplete

Ask concise follow-up questions when any of these would materially change the design:

- What should the workflow be called?
- What are the phases, in order?
- What should the final result contain?
- Should it be manual-only or scheduled?
- If scheduled, what frequency and timezone should it use?
- What inputs should be configurable vs defaulted?
- What external systems does it touch?
- What failure mode matters most?

## Defaults You Can Usually Assume

These are usually safe unless the user says otherwise:

- `runnerType: "node"`
- a canonical `run-workflow.js` entrypoint
- `tests/` contains at least a smoke test
- schedules start empty unless the user asked for one
- `latestResultPolicy: "on-success"`
- workflow state is not written into the workflow folder itself

## After You Have The Spec

1. Run `bootstrap-workspace.js` if needed
2. Run `new-workflow.js`
3. Replace the placeholder implementation
4. Update `workflow.config.js`
5. Add tests
6. Sync schedules only after the schedule config is real
