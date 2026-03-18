# workflow.config.js

Each managed workflow exposes one canonical machine-readable file:

- `identity`
- `runtime`
- `schedules`
- `result`
- `observability`

The file must stay declarative:

- no filesystem writes
- no API calls
- no time-based dynamic values
- no runtime state such as `jobId`, counters, or summaries

`workflowId` and `scheduleId` are stable identifiers. OpenClaw `jobId` belongs to platform sync state, not to the workflow config.
