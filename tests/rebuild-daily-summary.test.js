const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scaffoldWorkflow } = require('../scripts/new-workflow');
const { rebuildDailySummary } = require('../scripts/rebuild-daily-summary');
const { runManagedWorkflow } = require('../scripts/run-workflow');

function createTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-workflows-summary-'));
}

function writeWorkflowConfig(workflowRoot, content) {
  fs.writeFileSync(path.join(workflowRoot, 'workflow.config.js'), content, 'utf8');
}

function withDailyCronConfig(scaffold) {
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
}

test('rebuild-daily-summary counts successful scheduled runs', async () => {
  const workspaceRoot = createTempWorkspace();
  const scaffold = scaffoldWorkflow({
    workspaceRoot,
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  });
  withDailyCronConfig(scaffold);

  await runManagedWorkflow({
    workspaceRoot,
    workflowId: 'daily-report',
    trigger: 'scheduled',
    scheduleId: 'morning',
    startedAt: '2026-03-18T07:05:00.000Z',
  });

  const rebuilt = rebuildDailySummary({
    workspaceRoot,
    date: '2026-03-18',
  });

  assert.equal(rebuilt.summary.expectedRuns, 1);
  assert.equal(rebuilt.summary.successfulRuns, 1);
  assert.equal(rebuilt.summary.missedRuns, 0);
  assert.equal(rebuilt.summary.workflows['daily-report'].latestResult.result.workflowId, 'daily-report');
});

test('rebuild-daily-summary counts missed runs when no execution happened', () => {
  const workspaceRoot = createTempWorkspace();
  const scaffold = scaffoldWorkflow({
    workspaceRoot,
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  });
  withDailyCronConfig(scaffold);

  const rebuilt = rebuildDailySummary({
    workspaceRoot,
    date: '2026-03-18',
  });

  assert.equal(rebuilt.summary.expectedRuns, 1);
  assert.equal(rebuilt.summary.missedRuns, 1);
  assert.equal(rebuilt.summary.successfulRuns, 0);
});
