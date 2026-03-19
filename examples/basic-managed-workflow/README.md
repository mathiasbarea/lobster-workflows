# basic-managed-workflow

Minimal self-contained example of a managed workflow.

It shows the recommended baseline shape:

- `runnerType: 'lobster'`
- `.lobster` entrypoint
- success envelope emitted by a local Node step
- result extraction from `output.0.data`
