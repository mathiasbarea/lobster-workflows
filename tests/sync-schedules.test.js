const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scaffoldWorkflow } = require('../scripts/new-workflow');
const { syncSchedules } = require('../scripts/sync-schedules');
const {
  buildExpectedManagedJob,
  inspectWorkflowScheduleSync,
} = require('../scripts/lib/cron-sync');
const {
  readSyncState,
  writeSyncState,
} = require('../scripts/lib/execution-store');
const { loadWorkflow } = require('../scripts/lib/workflow-loader');
const skillRoot = path.resolve(__dirname, '..');

function createTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-workflows-sync-'));
}

function writeWorkflowConfig(workflowRoot, content) {
  fs.writeFileSync(path.join(workflowRoot, 'workflow.config.js'), content, 'utf8');
}

test('sync-schedules adds new managed jobs and disables obsolete ones', () => {
  const workspaceRoot = createTempWorkspace();
  const scaffold = scaffoldWorkflow({
    workspaceRoot,
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  });

  writeWorkflowConfig(scaffold.workflowRoot, `module.exports = {
  identity: {
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  },
  runtime: {
    runnerType: 'node',
    entrypoint: 'run-workflow.js',
    defaultAction: 'run',
    workingDirectory: '.',
    defaultInputs: {},
  },
  schedules: [
    {
      scheduleId: 'morning',
      kind: 'cron',
      cron: '0 7 * * *',
      timezone: 'UTC',
      enabled: true,
    },
  ],
  result: {
    resultType: 'object',
    resultDescription: 'Canonical workflow result payload',
    latestResultPolicy: 'on-success',
    extractor: {
      sourceAction: 'run',
      dataPath: null,
    },
  },
  observability: {
    successCondition: {
      ok: true,
    },
    defaultTimeoutMs: 30000,
  },
};
`);

  const calls = [];
  const runCommandFn = (command, args) => {
    calls.push({ command, args });
    if (args[0] === 'cron' && args[1] === 'list') {
      return {
        ok: true,
        stdout: JSON.stringify({
          jobs: [
            { id: 'job-old', name: 'lobster-workflows::daily-report::old-schedule' },
          ],
        }),
        stderr: '',
      };
    }
    if (args[0] === 'cron' && args[1] === 'add') {
      return {
        ok: true,
        stdout: JSON.stringify({ jobId: 'job-new' }),
        stderr: '',
      };
    }
    if (args[0] === 'cron' && args[1] === 'disable') {
      return {
        ok: true,
        stdout: '',
        stderr: '',
      };
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };

  const result = syncSchedules({
    workspaceRoot,
    workflowId: 'daily-report',
    skillRoot,
    openclawCommand: 'openclaw',
    runCommandFn,
  });

  assert.equal(result.workflowCount, 1);
  assert.equal(result.workflows[0].operations.some((operation) => operation.type === 'add'), true);
  assert.equal(result.workflows[0].operations.some((operation) => operation.type === 'disable'), true);
  assert.equal(calls.some((call) => call.args[1] === 'add'), true);
  assert.equal(calls.some((call) => call.args.includes('--timeout') && call.args.includes('30000')), true);
});

test('sync-schedules edits an existing managed job when schedule still exists', () => {
  const workspaceRoot = createTempWorkspace();
  const scaffold = scaffoldWorkflow({
    workspaceRoot,
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  });

  writeWorkflowConfig(scaffold.workflowRoot, `module.exports = {
  identity: {
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  },
  runtime: {
    runnerType: 'node',
    entrypoint: 'run-workflow.js',
    defaultAction: 'run',
    workingDirectory: '.',
    defaultInputs: {},
  },
  schedules: [
    {
      scheduleId: 'morning',
      kind: 'cron',
      cron: '0 7 * * *',
      timezone: 'UTC',
      enabled: true,
    },
  ],
  result: {
    resultType: 'object',
    resultDescription: 'Canonical workflow result payload',
    latestResultPolicy: 'on-success',
    extractor: {
      sourceAction: 'run',
      dataPath: null,
    },
  },
  observability: {
    successCondition: {
      ok: true,
    },
    defaultTimeoutMs: 30000,
  },
};
`);

  const calls = [];
  const runCommandFn = (command, args) => {
    calls.push({ command, args });
    if (args[0] === 'cron' && args[1] === 'list') {
      return {
        ok: true,
        stdout: JSON.stringify({
          jobs: [
            { id: 'job-1', name: 'lobster-workflows::daily-report::morning' },
          ],
        }),
        stderr: '',
      };
    }
    if (args[0] === 'cron' && args[1] === 'edit') {
      return {
        ok: true,
        stdout: '',
        stderr: '',
      };
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };

  const result = syncSchedules({
    workspaceRoot,
    workflowId: 'daily-report',
    skillRoot,
    openclawCommand: 'openclaw',
    runCommandFn,
  });

  assert.equal(result.workflows[0].operations.some((operation) => operation.type === 'edit'), true);
  assert.equal(calls.some((call) => call.args[1] === 'edit'), true);
  assert.equal(calls.some((call) => call.args.includes('--timeout') && call.args.includes('30000')), true);
});

test('sync-schedules supports the gateway backend directly', () => {
  const workspaceRoot = createTempWorkspace();
  const scaffold = scaffoldWorkflow({
    workspaceRoot,
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  });

  writeWorkflowConfig(scaffold.workflowRoot, `module.exports = {
  identity: {
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  },
  runtime: {
    runnerType: 'node',
    entrypoint: 'run-workflow.js',
    defaultAction: 'run',
    workingDirectory: '.',
    defaultInputs: {},
  },
  schedules: [
    {
      scheduleId: 'morning',
      kind: 'cron',
      cron: '0 7 * * *',
      timezone: 'UTC',
      enabled: true,
    },
  ],
  result: {
    resultType: 'object',
    resultDescription: 'Canonical workflow result payload',
    latestResultPolicy: 'on-success',
    extractor: {
      sourceAction: 'run',
      dataPath: null,
    },
  },
  observability: {
    successCondition: {
      ok: true,
    },
    defaultTimeoutMs: 30000,
  },
};
`);

  const calls = [];
  const runCommandFn = (command, args) => {
    calls.push({ command, args });
    if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'cron.list') {
      return {
        ok: true,
        stdout: JSON.stringify({
          jobs: [],
          hasMore: false,
          nextOffset: 0,
        }),
        stderr: '',
      };
    }
    if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'cron.add') {
      return {
        ok: true,
        stdout: JSON.stringify({ id: 'job-gateway-new' }),
        stderr: '',
      };
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };

  const result = syncSchedules({
    workspaceRoot,
    workflowId: 'daily-report',
    skillRoot,
    syncBackend: 'gateway',
    openclawCommand: 'openclaw',
    runCommandFn,
  });

  assert.equal(result.workflows[0].selectedBackend, 'gateway');
  assert.equal(result.workflows[0].operations.some((operation) => operation.type === 'add' && operation.applied === true), true);
  assert.equal(calls.some((call) => call.args[2] === 'cron.list'), true);
  assert.equal(calls.some((call) => call.args[2] === 'cron.add'), true);
});

test('sync-schedules falls back from cli to gateway when auto backend hits a cli transport failure', () => {
  const workspaceRoot = createTempWorkspace();
  const scaffold = scaffoldWorkflow({
    workspaceRoot,
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  });

  writeWorkflowConfig(scaffold.workflowRoot, `module.exports = {
  identity: {
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  },
  runtime: {
    runnerType: 'node',
    entrypoint: 'run-workflow.js',
    defaultAction: 'run',
    workingDirectory: '.',
    defaultInputs: {},
  },
  schedules: [
    {
      scheduleId: 'morning',
      kind: 'cron',
      cron: '0 7 * * *',
      timezone: 'UTC',
      enabled: true,
    },
  ],
  result: {
    resultType: 'object',
    resultDescription: 'Canonical workflow result payload',
    latestResultPolicy: 'on-success',
    extractor: {
      sourceAction: 'run',
      dataPath: null,
    },
  },
  observability: {
    successCondition: {
      ok: true,
    },
    defaultTimeoutMs: 30000,
  },
};
`);

  const calls = [];
  const runCommandFn = (command, args) => {
    calls.push({ command, args });
    if (args[0] === 'cron' && args[1] === 'list') {
      return {
        ok: false,
        stdout: '',
        stderr: 'gateway connect failed: Error: gateway closed (1000 normal closure): no close reason',
        errorMessage: null,
      };
    }
    if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'cron.list') {
      return {
        ok: true,
        stdout: JSON.stringify({
          jobs: [],
          hasMore: false,
          nextOffset: 0,
        }),
        stderr: '',
      };
    }
    if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'cron.add') {
      return {
        ok: true,
        stdout: JSON.stringify({ id: 'job-gateway-fallback' }),
        stderr: '',
      };
    }
    if (args[0] === 'gateway' && args[1] === 'status') {
      return {
        ok: true,
        stdout: JSON.stringify({
          gateway: {
            bindHost: '127.0.0.1',
            port: 18789,
            probeUrl: 'ws://127.0.0.1:18789',
          },
          port: {
            listeners: [{ address: '127.0.0.1:18789' }],
          },
          rpc: {
            ok: true,
            url: 'ws://127.0.0.1:18789',
          },
        }),
        stderr: '',
      };
    }
    if (args[0] === 'status') {
      return {
        ok: true,
        stdout: JSON.stringify({
          gateway: {
            reachable: false,
            error: 'missing scope: operator.read',
          },
        }),
        stderr: '',
      };
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };

  const result = syncSchedules({
    workspaceRoot,
    workflowId: 'daily-report',
    skillRoot,
    syncBackend: 'auto',
    openclawCommand: 'openclaw',
    openclawRetryCount: 0,
    runCommandFn,
  });

  assert.equal(result.workflows[0].selectedBackend, 'gateway');
  assert.deepEqual(result.workflows[0].backendAttempts, [
    {
      backend: 'cli',
      ok: false,
      error: 'Failed to list cron jobs via cli backend: gateway connect failed: Error: gateway closed (1000 normal closure): no close reason. Gateway diagnostics: gateway RPC ok (ws://127.0.0.1:18789; listening 127.0.0.1:18789); operator-level status unavailable (missing scope: operator.read)',
    },
    {
      backend: 'gateway',
      ok: true,
    },
  ]);
  assert.equal(result.workflows[0].operations.some((operation) => operation.type === 'add' && operation.applied === true), true);
  assert.equal(calls.some((call) => call.args[0] === 'cron' && call.args[1] === 'add'), false);
  assert.equal(calls.some((call) => call.args[2] === 'cron.add'), true);
});

test('sync-schedules retries transient gateway failures before listing cron jobs', () => {
  const workspaceRoot = createTempWorkspace();
  const scaffold = scaffoldWorkflow({
    workspaceRoot,
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  });

  writeWorkflowConfig(scaffold.workflowRoot, `module.exports = {
  identity: {
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  },
  runtime: {
    runnerType: 'node',
    entrypoint: 'run-workflow.js',
    defaultAction: 'run',
    workingDirectory: '.',
    defaultInputs: {},
  },
  schedules: [
    {
      scheduleId: 'morning',
      kind: 'cron',
      cron: '0 7 * * *',
      timezone: 'UTC',
      enabled: true,
    },
  ],
  result: {
    resultType: 'object',
    resultDescription: 'Canonical workflow result payload',
    latestResultPolicy: 'on-success',
    extractor: {
      sourceAction: 'run',
      dataPath: null,
    },
  },
  observability: {
    successCondition: {
      ok: true,
    },
    defaultTimeoutMs: 30000,
  },
};
`);

  let listAttempts = 0;
  const sleepCalls = [];
  const runCommandFn = (command, args) => {
    if (args[0] === 'cron' && args[1] === 'list') {
      listAttempts += 1;
      if (listAttempts < 3) {
        return {
          ok: false,
          stdout: '',
          stderr: 'gateway connect failed: Error: gateway closed (1000 normal closure): no close reason',
          errorMessage: null,
        };
      }
      return {
        ok: true,
        stdout: JSON.stringify({ jobs: [] }),
        stderr: '',
      };
    }
    if (args[0] === 'cron' && args[1] === 'add') {
      return {
        ok: true,
        stdout: JSON.stringify({ jobId: 'job-new' }),
        stderr: '',
      };
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };

  const result = syncSchedules({
    workspaceRoot,
    workflowId: 'daily-report',
    skillRoot,
    openclawCommand: 'openclaw',
    openclawRetryCount: 2,
    openclawRetryDelayMs: 5,
    runCommandFn,
    sleepFn: (delayMs) => sleepCalls.push(delayMs),
  });

  assert.equal(result.workflowCount, 1);
  assert.equal(listAttempts, 3);
  assert.deepEqual(sleepCalls, [5, 10]);
  assert.equal(result.workflows[0].operations.some((operation) => operation.type === 'add'), true);
});

test('sync-schedules fails fast for non-transient cron list failures', () => {
  const workspaceRoot = createTempWorkspace();
  const scaffold = scaffoldWorkflow({
    workspaceRoot,
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  });

  writeWorkflowConfig(scaffold.workflowRoot, `module.exports = {
  identity: {
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  },
  runtime: {
    runnerType: 'node',
    entrypoint: 'run-workflow.js',
    defaultAction: 'run',
    workingDirectory: '.',
    defaultInputs: {},
  },
  schedules: [
    {
      scheduleId: 'morning',
      kind: 'cron',
      cron: '0 7 * * *',
      timezone: 'UTC',
      enabled: true,
    },
  ],
  result: {
    resultType: 'object',
    resultDescription: 'Canonical workflow result payload',
    latestResultPolicy: 'on-success',
    extractor: {
      sourceAction: 'run',
      dataPath: null,
    },
  },
  observability: {
    successCondition: {
      ok: true,
    },
    defaultTimeoutMs: 30000,
  },
};
`);

  let listAttempts = 0;
  const sleepCalls = [];
  const runCommandFn = (command, args) => {
    if (args[0] === 'cron' && args[1] === 'list') {
      listAttempts += 1;
      return {
        ok: false,
        stdout: '',
        stderr: 'invalid option: --bogus',
        errorMessage: null,
      };
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };

  assert.throws(() => syncSchedules({
    workspaceRoot,
    workflowId: 'daily-report',
    skillRoot,
    syncBackend: 'cli',
    openclawCommand: 'openclaw',
    openclawRetryCount: 2,
    openclawRetryDelayMs: 5,
    runCommandFn,
    sleepFn: (delayMs) => sleepCalls.push(delayMs),
  }), /Failed to list cron jobs via cli backend: invalid option: --bogus/u);

  assert.equal(listAttempts, 1);
  assert.deepEqual(sleepCalls, []);
  const failedState = readSyncState(workspaceRoot, 'daily-report');
  assert.equal(failedState?.status, 'failed');
  assert.equal(failedState?.recoveryOnly, false);
  assert.match(failedState?.error || '', /invalid option: --bogus/u);
  assert.equal(failedState?.lastSuccessfulState, null);
});

test('sync-schedules includes gateway diagnostics when cron list cannot reach usable gateway state', () => {
  const workspaceRoot = createTempWorkspace();
  const scaffold = scaffoldWorkflow({
    workspaceRoot,
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  });

  writeWorkflowConfig(scaffold.workflowRoot, `module.exports = {
  identity: {
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  },
  runtime: {
    runnerType: 'node',
    entrypoint: 'run-workflow.js',
    defaultAction: 'run',
    workingDirectory: '.',
    defaultInputs: {},
  },
  schedules: [
    {
      scheduleId: 'morning',
      kind: 'cron',
      cron: '0 7 * * *',
      timezone: 'UTC',
      enabled: true,
    },
  ],
  result: {
    resultType: 'object',
    resultDescription: 'Canonical workflow result payload',
    latestResultPolicy: 'on-success',
    extractor: {
      sourceAction: 'run',
      dataPath: null,
    },
  },
  observability: {
    successCondition: {
      ok: true,
    },
    defaultTimeoutMs: 30000,
  },
};
`);

  const runCommandFn = (command, args) => {
    if (args[0] === 'cron' && args[1] === 'list') {
      return {
        ok: false,
        stdout: '',
        stderr: 'gateway connect failed: Error: gateway closed (1000 normal closure): no close reason',
        errorMessage: null,
      };
    }
    if (args[0] === 'gateway' && args[1] === 'status') {
      return {
        ok: true,
        stdout: JSON.stringify({
          gateway: {
            bindHost: '127.0.0.1',
            port: 18789,
            probeUrl: 'ws://127.0.0.1:18789',
          },
          port: {
            listeners: [{ address: '127.0.0.1:18789' }],
          },
          rpc: {
            ok: true,
            url: 'ws://127.0.0.1:18789',
          },
        }),
        stderr: '',
      };
    }
    if (args[0] === 'status') {
      return {
        ok: true,
        stdout: JSON.stringify({
          gateway: {
            reachable: false,
            error: 'missing scope: operator.read',
          },
        }),
        stderr: '',
      };
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };

  const result = syncSchedules({
    workspaceRoot,
    workflowId: 'daily-report',
    skillRoot,
    syncBackend: 'cli',
    openclawCommand: 'openclaw',
    openclawRetryCount: 0,
    runCommandFn,
  });

  assert.equal(result.workflows[0].status, 'recovery-only');
  assert.match(result.workflows[0].error, /Gateway diagnostics: gateway RPC ok \(ws:\/\/127\.0\.0\.1:18789; listening 127\.0\.0\.1:18789\); operator-level status unavailable \(missing scope: operator\.read\)/u);
  assert.equal(result.workflows[0].operations.length, 0);
  assert.equal(result.workflows[0].recovery?.mode, 'retry-guidance');
  const persistedState = readSyncState(workspaceRoot, 'daily-report');
  assert.equal(persistedState?.status, 'recovery-only');
  assert.equal(persistedState?.recoveryOnly, true);
  assert.equal(persistedState?.lastSuccessfulState, null);
});

test('sync-schedules dry-run returns planned operations and remediation without mutating sync state', () => {
  const workspaceRoot = createTempWorkspace();
  const scaffold = scaffoldWorkflow({
    workspaceRoot,
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  });

  writeWorkflowConfig(scaffold.workflowRoot, `module.exports = {
  identity: {
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  },
  runtime: {
    runnerType: 'node',
    entrypoint: 'run-workflow.js',
    defaultAction: 'run',
    workingDirectory: '.',
    defaultInputs: {},
  },
  schedules: [
    {
      scheduleId: 'morning',
      kind: 'cron',
      cron: '0 7 * * *',
      timezone: 'UTC',
      enabled: true,
    },
  ],
  result: {
    resultType: 'object',
    resultDescription: 'Canonical workflow result payload',
    latestResultPolicy: 'on-success',
    extractor: {
      sourceAction: 'run',
      dataPath: null,
    },
  },
  observability: {
    successCondition: {
      ok: true,
    },
    defaultTimeoutMs: 30000,
  },
};
`);

  const calls = [];
  const runCommandFn = (command, args) => {
    calls.push({ command, args });
    if (args[0] === 'cron' && args[1] === 'list') {
      return {
        ok: true,
        stdout: JSON.stringify({ jobs: [] }),
        stderr: '',
      };
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };

  const result = syncSchedules({
    workspaceRoot,
    workflowId: 'daily-report',
    skillRoot,
    dryRun: true,
    runCommandFn,
  });

  assert.equal(result.workflows[0].dryRun, true);
  assert.equal(result.workflows[0].operations.length, 1);
  assert.equal(result.workflows[0].operations[0].type, 'add');
  assert.equal(result.workflows[0].operations[0].applied, false);
  assert.equal(typeof result.workflows[0].operations[0].remediation?.cli?.command, 'string');
  assert.equal(result.workflows[0].operations[0].remediation?.gateway?.method, 'cron.add');
  assert.equal(calls.some((call) => call.args[0] === 'cron' && call.args[1] === 'add'), false);
  assert.equal(readSyncState(workspaceRoot, 'daily-report'), null);
});

test('sync-schedules returns recovery-only remediation from the last sync state when cli access fails recoverably', () => {
  const workspaceRoot = createTempWorkspace();
  const scaffold = scaffoldWorkflow({
    workspaceRoot,
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  });

  writeWorkflowConfig(scaffold.workflowRoot, `module.exports = {
  identity: {
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  },
  runtime: {
    runnerType: 'node',
    entrypoint: 'run-workflow.js',
    defaultAction: 'run',
    workingDirectory: '.',
    defaultInputs: {},
  },
  schedules: [
    {
      scheduleId: 'morning',
      kind: 'cron',
      cron: '0 7 * * *',
      timezone: 'UTC',
      enabled: true,
    },
  ],
  result: {
    resultType: 'object',
    resultDescription: 'Canonical workflow result payload',
    latestResultPolicy: 'on-success',
    extractor: {
      sourceAction: 'run',
      dataPath: null,
    },
  },
  observability: {
    successCondition: {
      ok: true,
    },
    defaultTimeoutMs: 30000,
  },
};
`);

  writeSyncState({
    workspaceRoot,
    workflowId: 'daily-report',
    state: {
      workflowId: 'daily-report',
      generatedAt: '2026-03-18T22:30:00.000Z',
      requestedBackend: 'gateway',
      selectedBackend: 'gateway',
      dryRun: false,
      schedules: [
        {
          scheduleId: 'morning',
          jobId: 'job-prev',
          jobName: 'lobster-workflows::daily-report::morning',
          enabled: true,
        },
      ],
      operations: [],
    },
  });
  const previousState = readSyncState(workspaceRoot, 'daily-report');

  const runCommandFn = (command, args) => {
    if (args[0] === 'cron' && args[1] === 'list') {
      return {
        ok: false,
        stdout: '',
        stderr: 'gateway connect failed: Error: gateway closed (1000 normal closure): no close reason',
        errorMessage: null,
      };
    }
    if (args[0] === 'gateway' && args[1] === 'status') {
      return {
        ok: true,
        stdout: JSON.stringify({
          gateway: {
            bindHost: '127.0.0.1',
            port: 18789,
            probeUrl: 'ws://127.0.0.1:18789',
          },
          port: {
            listeners: [{ address: '127.0.0.1:18789' }],
          },
          rpc: {
            ok: true,
            url: 'ws://127.0.0.1:18789',
          },
        }),
        stderr: '',
      };
    }
    if (args[0] === 'status') {
      return {
        ok: true,
        stdout: JSON.stringify({
          gateway: {
            reachable: false,
            error: 'missing scope: operator.read',
          },
        }),
        stderr: '',
      };
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };

  const result = syncSchedules({
    workspaceRoot,
    workflowId: 'daily-report',
    skillRoot,
    syncBackend: 'cli',
    openclawCommand: 'openclaw',
    openclawRetryCount: 0,
    runCommandFn,
  });

  const workflowResult = result.workflows[0];
  assert.equal(workflowResult.status, 'recovery-only');
  assert.equal(workflowResult.recoveryOnly, true);
  assert.equal(workflowResult.dryRun, true);
  assert.equal(workflowResult.selectedBackend, null);
  assert.equal(workflowResult.operations.length, 1);
  assert.equal(workflowResult.operations[0].type, 'edit');
  assert.equal(workflowResult.operations[0].jobId, 'job-prev');
  assert.equal(workflowResult.operations[0].applied, false);
  assert.equal(workflowResult.operations[0].remediation?.gateway?.method, 'cron.update');
  assert.equal(workflowResult.recovery?.mode, 'sync-state-dry-run');
  assert.equal(workflowResult.recovery?.lastSyncState?.generatedAt, '2026-03-18T22:30:00.000Z');
  assert.equal(workflowResult.recovery?.retryCommands?.some((command) => command.label === 'retry-gateway'), true);
  assert.match(workflowResult.error, /Failed to list cron jobs via cli backend/u);
  const persistedState = readSyncState(workspaceRoot, 'daily-report');
  assert.equal(persistedState?.status, 'recovery-only');
  assert.equal(persistedState?.recoveryOnly, true);
  assert.equal(persistedState?.recovery?.mode, 'sync-state-dry-run');
  assert.deepEqual(persistedState?.lastSuccessfulState, previousState);
});

test('sync-schedules persists partial state when an operation fails after earlier cron changes were applied', () => {
  const workspaceRoot = createTempWorkspace();
  const scaffold = scaffoldWorkflow({
    workspaceRoot,
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  });

  writeWorkflowConfig(scaffold.workflowRoot, `module.exports = {
  identity: {
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  },
  runtime: {
    runnerType: 'node',
    entrypoint: 'run-workflow.js',
    defaultAction: 'run',
    workingDirectory: '.',
    defaultInputs: {},
  },
  schedules: [
    {
      scheduleId: 'morning',
      kind: 'cron',
      cron: '0 7 * * *',
      timezone: 'UTC',
      enabled: true,
    },
    {
      scheduleId: 'night',
      kind: 'cron',
      cron: '0 23 * * *',
      timezone: 'UTC',
      enabled: true,
    },
  ],
  result: {
    resultType: 'object',
    resultDescription: 'Canonical workflow result payload',
    latestResultPolicy: 'on-success',
    extractor: {
      sourceAction: 'run',
      dataPath: null,
    },
  },
  observability: {
    successCondition: {
      ok: true,
    },
    defaultTimeoutMs: 30000,
  },
};
`);

  const calls = [];
  const runCommandFn = (command, args) => {
    calls.push({ command, args });
    if (args[0] === 'cron' && args[1] === 'list') {
      return {
        ok: true,
        stdout: JSON.stringify({ jobs: [] }),
        stderr: '',
      };
    }
    if (args[0] === 'cron' && args[1] === 'add' && args.includes('lobster-workflows::daily-report::morning')) {
      return {
        ok: true,
        stdout: JSON.stringify({ jobId: 'job-morning' }),
        stderr: '',
      };
    }
    if (args[0] === 'cron' && args[1] === 'add' && args.includes('lobster-workflows::daily-report::night')) {
      return {
        ok: false,
        stdout: '',
        stderr: 'gateway connect failed: Error: gateway closed (1000 normal closure): no close reason',
        errorMessage: null,
      };
    }
    if (args[0] === 'gateway' && args[1] === 'status') {
      return {
        ok: true,
        stdout: JSON.stringify({
          gateway: {
            bindHost: '127.0.0.1',
            port: 18789,
            probeUrl: 'ws://127.0.0.1:18789',
          },
          port: {
            listeners: [{ address: '127.0.0.1:18789' }],
          },
          rpc: {
            ok: true,
            url: 'ws://127.0.0.1:18789',
          },
        }),
        stderr: '',
      };
    }
    if (args[0] === 'status') {
      return {
        ok: true,
        stdout: JSON.stringify({
          gateway: {
            reachable: false,
            error: 'missing scope: operator.read',
          },
        }),
        stderr: '',
      };
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
  };

  assert.throws(() => syncSchedules({
    workspaceRoot,
    workflowId: 'daily-report',
    skillRoot,
    syncBackend: 'cli',
    openclawCommand: 'openclaw',
    openclawRetryCount: 0,
    runCommandFn,
  }), /Failed to add cron job for daily-report\/night via cli backend/u);

  const partialState = readSyncState(workspaceRoot, 'daily-report');
  assert.equal(partialState?.status, 'partial');
  assert.equal(partialState?.recoveryOnly, false);
  assert.equal(partialState?.operations?.[0]?.scheduleId, 'morning');
  assert.equal(partialState?.operations?.[0]?.applied, true);
  assert.equal(partialState?.operations?.[1]?.scheduleId, 'night');
  assert.equal(partialState?.operations?.[1]?.applied, false);
  assert.equal(partialState?.recovery?.mode, 'partial-failure');
  assert.equal(partialState?.lastSuccessfulState, null);
  assert.equal(calls.some((call) => call.args.includes('lobster-workflows::daily-report::morning')), true);
  assert.equal(calls.some((call) => call.args.includes('lobster-workflows::daily-report::night')), true);
});

test('sync-schedules disables duplicate managed jobs for the same active schedule', () => {
  const workspaceRoot = createTempWorkspace();
  const scaffold = scaffoldWorkflow({
    workspaceRoot,
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  });

  writeWorkflowConfig(scaffold.workflowRoot, `module.exports = {
  identity: {
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  },
  runtime: {
    runnerType: 'node',
    entrypoint: 'run-workflow.js',
    defaultAction: 'run',
    workingDirectory: '.',
    defaultInputs: {},
  },
  schedules: [
    {
      scheduleId: 'morning',
      kind: 'cron',
      cron: '0 7 * * *',
      timezone: 'UTC',
      enabled: true,
    },
  ],
  result: {
    resultType: 'object',
    resultDescription: 'Canonical workflow result payload',
    latestResultPolicy: 'on-success',
    extractor: {
      sourceAction: 'run',
      dataPath: null,
    },
  },
  observability: {
    successCondition: {
      ok: true,
    },
    defaultTimeoutMs: 30000,
  },
};
`);

  const calls = [];
  const runCommandFn = (command, args) => {
    calls.push({ command, args });
    if (args[0] === 'cron' && args[1] === 'list') {
      return {
        ok: true,
        stdout: JSON.stringify({
          jobs: [
            { id: 'job-primary', name: 'lobster-workflows::daily-report::morning', enabled: true },
            { id: 'job-duplicate', name: 'lobster-workflows::daily-report::morning', enabled: true },
          ],
        }),
        stderr: '',
      };
    }
    if (args[0] === 'cron' && args[1] === 'edit') {
      return {
        ok: true,
        stdout: '',
        stderr: '',
      };
    }
    if (args[0] === 'cron' && args[1] === 'disable') {
      return {
        ok: true,
        stdout: '',
        stderr: '',
      };
    }
    throw new Error(`Unexpected command: ${args.join(' ')}`);
  };

  const result = syncSchedules({
    workspaceRoot,
    workflowId: 'daily-report',
    skillRoot,
    openclawCommand: 'openclaw',
    runCommandFn,
  });

  assert.equal(result.workflows[0].operations.some((operation) => operation.type === 'disable-duplicate'), true);
  assert.equal(calls.some((call) => call.args[1] === 'disable' && call.args[2] === 'job-duplicate'), true);
});

test('inspect workflow schedule sync detects missing, mismatched, duplicate, and unexpected jobs', () => {
  const workspaceRoot = createTempWorkspace();
  const scaffold = scaffoldWorkflow({
    workspaceRoot,
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  });

  writeWorkflowConfig(scaffold.workflowRoot, `module.exports = {
  identity: {
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  },
  runtime: {
    runnerType: 'node',
    entrypoint: 'run-workflow.js',
    defaultAction: 'run',
    workingDirectory: '.',
    defaultInputs: {},
  },
  schedules: [
    {
      scheduleId: 'morning',
      kind: 'cron',
      cron: '0 7 * * *',
      timezone: 'UTC',
      enabled: true,
    },
    {
      scheduleId: 'night',
      kind: 'cron',
      cron: '0 23 * * *',
      timezone: 'UTC',
      enabled: true,
    },
  ],
  result: {
    resultType: 'object',
    resultDescription: 'Canonical workflow result payload',
    latestResultPolicy: 'on-success',
    extractor: {
      sourceAction: 'run',
      dataPath: null,
    },
  },
  observability: {
    successCondition: {
      ok: true,
    },
    defaultTimeoutMs: 30000,
  },
};
`);

  const workflow = loadWorkflow(workspaceRoot, 'daily-report');
  const expectedMorning = buildExpectedManagedJob({
    workflow,
    schedule: workflow.config.schedules[0],
    skillRoot,
    workspaceRoot,
  });

  const inspection = inspectWorkflowScheduleSync({
    workspaceRoot,
    workflow,
    skillRoot,
    jobs: [
      {
        id: 'job-morning-primary',
        ...expectedMorning,
      },
      {
        id: 'job-morning-duplicate',
        ...expectedMorning,
      },
      {
        id: 'job-old',
        name: 'lobster-workflows::daily-report::old-schedule',
        enabled: true,
        schedule: {
          kind: 'cron',
          expr: '0 1 * * *',
          tz: 'UTC',
        },
      },
    ],
  });

  const types = inspection.drift.map((entry) => entry.type);
  assert.equal(inspection.inSync, false);
  assert.equal(types.includes('duplicate-enabled-jobs'), true);
  assert.equal(types.includes('missing-active-job'), true);
  assert.equal(types.includes('unexpected-enabled-job'), true);
});
