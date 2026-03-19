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
    openclawCommand: 'openclaw',
    openclawRetryCount: 2,
    openclawRetryDelayMs: 5,
    runCommandFn,
    sleepFn: (delayMs) => sleepCalls.push(delayMs),
  }), /Failed to list cron jobs: invalid option: --bogus/u);

  assert.equal(listAttempts, 1);
  assert.deepEqual(sleepCalls, []);
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

  assert.throws(() => syncSchedules({
    workspaceRoot,
    workflowId: 'daily-report',
    skillRoot,
    openclawCommand: 'openclaw',
    openclawRetryCount: 0,
    runCommandFn,
  }), /Gateway diagnostics: gateway RPC ok \(ws:\/\/127\.0\.0\.1:18789; listening 127\.0\.0\.1:18789\); operator-level status unavailable \(missing scope: operator\.read\)/u);
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
