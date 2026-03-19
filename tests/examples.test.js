const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { runCommand } = require('../scripts/lib/process-utils');

function getExampleRoot(name) {
  return path.join(__dirname, '..', 'examples', name);
}

function readJsonLikeModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

test('basic managed example is self-contained and runnable with lobster', () => {
  const exampleRoot = getExampleRoot('basic-managed-workflow');
  const config = readJsonLikeModule(path.join(exampleRoot, 'workflow.config.js'));

  assert.equal(config.runtime.runnerType, 'lobster');
  assert.equal(config.runtime.entrypoint, 'basic-managed-workflow.lobster');

  const result = runCommand('lobster', [
    'run',
    '--mode',
    'tool',
    '--file',
    path.join(exampleRoot, config.runtime.entrypoint),
  ], {
    cwd: exampleRoot,
    timeoutMs: 30000,
  });

  assert.equal(result.ok, true, result.stderr || result.errorMessage);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.status, 'ok');
  assert.equal(envelope.output[0].action, 'run');
  assert.equal(envelope.output[0].data.workflowId, 'basic-managed-workflow');
});

test('approval example is runnable and pauses with a Lobster approval envelope', () => {
  const exampleRoot = getExampleRoot('approval-telegram-smoke');
  const config = readJsonLikeModule(path.join(exampleRoot, 'workflow.config.js'));

  assert.equal(config.runtime.runnerType, 'lobster');
  assert.deepEqual(config.approvals.telegram.approvers, ['1234567890']);

  const result = runCommand('lobster', [
    'run',
    '--mode',
    'tool',
    '--file',
    path.join(exampleRoot, config.runtime.entrypoint),
  ], {
    cwd: exampleRoot,
    timeoutMs: 30000,
  });

  assert.equal(result.ok, true, result.stderr || result.errorMessage);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.status, 'needs_approval');
  assert.match(envelope.requiresApproval.prompt, /approve or reject/i);
  assert.equal(Boolean(envelope.requiresApproval.resumeToken), true);
});

test('public examples do not contain machine-specific absolute paths', () => {
  const examplesRoot = path.join(__dirname, '..', 'examples');
  const files = [];

  function walk(currentPath) {
    for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      files.push(fullPath);
    }
  }

  walk(examplesRoot);

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    assert.doesNotMatch(content, /C:\\Users\\mathi|C:\/Users\/mathi|\/Users\/mathi/u, filePath);
  }
});
