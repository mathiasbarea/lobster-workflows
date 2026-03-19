module.exports = {
  identity: {
    workflowId: 'basic-managed-workflow',
    displayName: 'Basic Managed Workflow',
    description: 'Minimal reference workflow for lobster-workflows',
  },
  runtime: {
    runnerType: 'lobster',
    entrypoint: 'basic-managed-workflow.lobster',
    defaultAction: 'run',
    workingDirectory: '.',
    defaultInputs: {},
  },
  schedules: [],
  result: {
    resultType: 'object',
    resultDescription: 'Basic managed workflow result payload',
    latestResultPolicy: 'on-success',
    extractor: {
      dataPath: 'output.0.data',
    },
  },
  observability: {
    successCondition: {
      ok: true,
      status: 'ok',
    },
    defaultTimeoutMs: 30000,
  },
};
