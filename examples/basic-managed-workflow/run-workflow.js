#!/usr/bin/env node

function successEnvelope(data) {
  return {
    ok: true,
    action: 'run',
    generatedAt: new Date().toISOString(),
    data,
    meta: {
      example: 'basic-managed-workflow',
    },
  };
}

process.stdout.write(`${JSON.stringify(successEnvelope({
  workflowId: 'basic-managed-workflow',
  status: 'ok',
  message: 'Basic managed workflow example completed.',
}), null, 2)}\n`);
