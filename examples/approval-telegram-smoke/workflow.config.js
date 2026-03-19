module.exports = {
  identity: {
    workflowId: 'approval-telegram-smoke',
    displayName: 'Approval Telegram Smoke',
    description: 'Minimal Telegram approval example for lobster-workflows',
  },
  runtime: {
    runnerType: 'lobster',
    entrypoint: 'approval-telegram-smoke.lobster',
    defaultAction: 'run',
    workingDirectory: '.',
    defaultInputs: {},
  },
  approvals: {
    telegram: {
      approvers: ['1234567890'],
    },
  },
  schedules: [],
  result: {
    resultType: 'object',
    resultDescription: 'Telegram approval example result',
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
