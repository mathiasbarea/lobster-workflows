const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scaffoldWorkflow } = require('../scripts/new-workflow');

function createTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-workflows-scaffold-'));
}

test('new-workflow creates a runnable workflow scaffold', async () => {
  const workspaceRoot = createTempWorkspace();
  const result = scaffoldWorkflow({
    workspaceRoot,
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  });

  assert.equal(fs.existsSync(path.join(result.workflowRoot, 'workflow.config.js')), true);
  assert.equal(fs.existsSync(path.join(result.workflowRoot, 'run-workflow.js')), true);
  assert.equal(fs.existsSync(path.join(result.workflowRoot, 'daily-report.lobster')), true);
  assert.equal(fs.existsSync(path.join(result.workflowRoot, 'tests', 'smoke.test.js')), true);
  const lobsterFile = fs.readFileSync(path.join(result.workflowRoot, 'daily-report.lobster'), 'utf8');

  const config = require(path.join(result.workflowRoot, 'workflow.config.js'));
  const { runAction } = require(path.join(result.workflowRoot, 'run-workflow.js'));
  const runResult = await runAction({
    action: 'run',
    flags: {},
    stdinText: JSON.stringify({ input: 1 }),
  });

  assert.equal(config.identity.workflowId, 'daily-report');
  assert.match(lobsterFile, /default: \.\/workflows\/daily-report/);
  assert.doesNotMatch(lobsterFile, new RegExp(result.workflowRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(runResult.ok, true);
  assert.equal(runResult.data.workflowId, 'daily-report');
  assert.deepEqual(runResult.data.receivedInput, { input: 1 });
});

test('new-workflow refuses to overwrite an existing workflow', () => {
  const workspaceRoot = createTempWorkspace();
  scaffoldWorkflow({
    workspaceRoot,
    workflowId: 'daily-report',
    displayName: 'Daily Report',
    description: 'Daily report workflow',
  });

  assert.throws(() => {
    scaffoldWorkflow({
      workspaceRoot,
      workflowId: 'daily-report',
      displayName: 'Daily Report',
      description: 'Daily report workflow',
    });
  }, /Workflow already exists/);
});
