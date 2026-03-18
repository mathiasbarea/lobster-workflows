# Testing Rules

Use this reference when adding or reviewing tests for a managed workflow.

## Location

Workflow tests go in:

```text
workflows/<workflow-id>/tests/
```

## Minimum Expectation

Every workflow should have:

- one smoke test proving the workflow loads correctly
- targeted tests for the most fragile phases

## What The Smoke Test Should Cover

At minimum:

- `workflow.config.js` is loadable
- `workflowId` is correct
- the managed entrypoint exists
- the default or named action returns a structured envelope

## What To Test Beyond Smoke

Prioritize:

- filesystem artifact gating
- external command boundaries
- parsing of tool or subprocess output
- failure shaping
- preservation of canonical fields used by later phases

## What Not To Optimize For

Do not try to fully integration-test every remote side effect in unit tests.

Prefer:

- fake runners
- temp directories
- synthetic fixtures

Then run a small real smoke only when the side effect is safe.

## Contract-Level Expectations

Tests should protect:

- success envelope shape
- error envelope shape
- result payload shape for the workflow's canonical result
- invariants that later phases rely on

## Good Failure Coverage

Try to cover:

- missing required files
- invalid JSON or malformed tool output
- partial artifact generation
- subprocess failure
- invalid user input
