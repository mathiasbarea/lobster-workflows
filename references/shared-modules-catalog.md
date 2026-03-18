# Shared Modules Catalog

Use this reference before adding new code to `workflows/_shared`.

## Purpose

`workflows/_shared` is for modules that can be imported directly by multiple workflows.

If a module knows about one specific workflow or one specific domain, it does not belong here.

## Shared Modules Bootstrapped Today

### `contracts.js`

Use for:

- `WorkflowError`
- standard success envelopes
- standard failure envelopes

Do not duplicate envelope or structured error logic inside each workflow unless there is a strong reason.

### `fs-utils.js`

Use for:

- directory creation
- JSON reading and writing
- path normalization
- existence checks

### `process-runner.js`

Use for:

- running child processes with normalized diagnostics
- consistent stdout/stderr capture
- timeout handling

### `openclaw-client.js`

Use for:

- workflow code that needs to call OpenClaw tool endpoints
- small integrations that are workflow-agnostic

### `artifact-checks.js`

Use for:

- checking whether expected files exist
- artifact gating helpers shared across workflows

## Decision Rule

Put code in `_shared` only if all of these are true:

- it is reusable across workflows
- it does not encode one workflow's business logic
- its API is stable enough to be worth sharing

If in doubt, keep the code inside the workflow first.

Promote it to `_shared` only after the shared shape is clear.

## Examples Of Code That Should Stay Inside The Workflow

- TikTok slideshow context collection
- domain-specific result shaping
- one workflow's prompt logic
- one workflow's image validation rules
- business-specific schedule interpretation
