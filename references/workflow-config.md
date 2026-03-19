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

If a workflow uses `runtime.runnerType: "lobster"`, it may pause with a Lobster approval checkpoint. That paused state is still runtime state and belongs in `_executions`, not in `workflow.config.js`.

Optional approval routing config may be declared in `workflow.config.js`:

```js
module.exports = {
  // ...
  approvals: {
    telegram: {
      approvers: ['1234567890'],
    },
  },
};
```

Rules:

- `approvers` are Telegram user IDs allowed to approve or reject
- approval delivery is DM-only in this skill and uses the approver IDs as delivery targets
- use numeric Telegram user IDs in `approvers`; do not rely on `@username` for approval authorization
