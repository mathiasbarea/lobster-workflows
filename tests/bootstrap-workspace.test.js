const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { bootstrapWorkspace, EXECUTION_DIRS } = require('../scripts/bootstrap-workspace');

function createTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-workflows-bootstrap-'));
}

test('bootstrap-workspace creates the expected platform layout', () => {
  const workspaceRoot = createTempWorkspace();
  const result = bootstrapWorkspace({ workspaceRoot });
  const workflowsRoot = path.join(workspaceRoot, 'workflows');

  assert.equal(fs.existsSync(workflowsRoot), true);
  assert.equal(fs.existsSync(path.join(workflowsRoot, '_shared')), true);
  assert.equal(fs.existsSync(path.join(workflowsRoot, '_executions')), true);

  for (const dirName of EXECUTION_DIRS) {
    assert.equal(fs.existsSync(path.join(workflowsRoot, '_executions', dirName)), true);
  }

  for (const fileName of ['README.md', 'contracts.js', 'fs-utils.js', 'openclaw-client.js', 'llm-task.js', 'process-runner.js', 'artifact-checks.js']) {
    assert.equal(fs.existsSync(path.join(workflowsRoot, '_shared', fileName)), true);
  }

  assert.equal(fs.existsSync(path.join(workflowsRoot, '.gitignore')), true);
  assert.equal(result.createdDirectories.length > 0, true);
});

test('bootstrap-workspace is idempotent for existing files', () => {
  const workspaceRoot = createTempWorkspace();
  bootstrapWorkspace({ workspaceRoot });
  const result = bootstrapWorkspace({ workspaceRoot });

  assert.equal(result.createdFiles.length, 0);
  assert.equal(result.existingFiles.length >= 1, true);
});
