const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scaffoldWorkflow } = require('../scripts/new-workflow');
const { runManagedWorkflow } = require('../scripts/run-workflow');

function createTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-workflows-run-'));
}

function writeWorkflowConfig(workflowRoot, content) {
  fs.writeFileSync(path.join(workflowRoot, 'workflow.config.js'), content, 'utf8');
}

test('run-workflow records manual runs and latest result', async () => {
  const workspaceRoot = createTempWorkspace();
  const scaffold = scaffoldWorkflow({
    workspaceRoot,
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  });

  const result = await runManagedWorkflow({
    workspaceRoot,
    workflowId: 'daily-report',
    trigger: 'manual',
    input: { value: 7 },
    startedAt: '2026-03-18T12:00:00.000Z',
  });

  assert.equal(result.status, 'success');
  assert.equal(fs.existsSync(result.runPath), true);
  assert.equal(fs.existsSync(result.latestResultPath), true);
  const latest = JSON.parse(fs.readFileSync(result.latestResultPath, 'utf8'));
  assert.equal(latest.workflowId, 'daily-report');
  assert.equal(latest.result.workflowId, 'daily-report');
});

test('run-workflow resolves scheduledFor for scheduled cron runs', async () => {
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
      countsTowardExpected: true,
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

  const result = await runManagedWorkflow({
    workspaceRoot,
    workflowId: 'daily-report',
    trigger: 'scheduled',
    scheduleId: 'morning',
    startedAt: '2026-03-18T07:10:00.000Z',
  });

  assert.equal(result.status, 'success');
  assert.equal(result.scheduledFor, '2026-03-18T07:00:00.000Z');
});
