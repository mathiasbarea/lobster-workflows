const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scaffoldWorkflow } = require('../scripts/new-workflow');
const { syncSchedules } = require('../scripts/sync-schedules');
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
