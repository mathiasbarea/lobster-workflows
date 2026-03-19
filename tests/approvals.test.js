const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scaffoldWorkflow } = require('../scripts/new-workflow');
const { writeRunRecord } = require('../scripts/lib/execution-store');
const { runCommand } = require('../scripts/lib/process-utils');
const { listPendingApprovals } = require('../scripts/list-pending-approvals');
const { resumeManagedWorkflow } = require('../scripts/resume-workflow');
const { runManagedWorkflow } = require('../scripts/run-workflow');

function createTempWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-workflows-approvals-'));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeWorkflowConfig(workflowRoot, content) {
  writeFile(path.join(workflowRoot, 'workflow.config.js'), content);
}

function writeNodeWorkflowConfig(workflowRoot, workflowId, displayName, description) {
  writeWorkflowConfig(workflowRoot, `module.exports = {
  identity: {
    workflowId: '${workflowId}',
    displayName: '${displayName}',
    description: '${description}',
  },
  runtime: {
    runnerType: 'node',
    entrypoint: 'run-workflow.js',
    defaultAction: 'run',
    workingDirectory: '.',
    defaultInputs: {},
  },
  schedules: [],
  result: {
    resultType: 'object',
    resultDescription: 'Approval result',
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

function writeNodeApprovalRunner(workflowRoot, prompt = 'Approve upload to Drive?') {
  writeFile(path.join(workflowRoot, 'run-workflow.js'), `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  ok: true,
  status: 'needs_approval',
  action: 'run',
  requiresApproval: {
    type: 'approval_request',
    prompt: ${JSON.stringify(prompt)},
    items: [{ step: 'upload-ready-to-drive' }],
    resumeToken: 'resume-token-123'
  },
  output: [{ postSlug: 'momentum-should-survive-handoffs' }]
}, null, 2));
`);
}

test('run-workflow records pending approvals and can list them for chat queries', async () => {
  const workspaceRoot = createTempWorkspace();
  const scaffold = scaffoldWorkflow({
    workspaceRoot,
    workflowId: 'approval-report',
    displayName: 'Approval Report',
    description: 'Approval workflow',
  });
  writeNodeWorkflowConfig(scaffold.workflowRoot, 'approval-report', 'Approval Report', 'Approval workflow');
  writeNodeApprovalRunner(scaffold.workflowRoot);

  const env = {
    ...process.env,
    LOBSTER_WORKFLOWS_TELEGRAM_APPROVERS: '12345,67890',
    LOBSTER_WORKFLOWS_TELEGRAM_PLUGIN_ENABLED: '1',
    LOBSTER_WORKFLOWS_OPENCLAW_BIN: 'definitely-missing-openclaw-binary',
  };

  const result = await runManagedWorkflow({
    workspaceRoot,
    workflowId: 'approval-report',
    trigger: 'manual',
    startedAt: '2026-03-18T12:00:00.000Z',
    env,
  });

  assert.equal(result.status, 'awaiting_approval');
  assert.equal(result.latestResultPath, null);
  assert.equal(result.approval.notifications.length, 2);

  const pending = listPendingApprovals({ workspaceRoot });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].workflowId, 'approval-report');
  assert.match(pending[0].prompt, /Approve upload to Drive/);
  const notification = result.approval.notifications[0];
  assert.equal(notification.channel, 'telegram');
  assert.match(notification.callbackApprove, /^\/lwf ap:[a-f0-9]{12}$/);
  assert.match(notification.callbackReject, /^\/lwf rj:[a-f0-9]{12}$/);
  assert.equal(['sent', 'failed'].includes(notification.deliveryStatus), true);
});

test('resume-workflow resumes lobster approvals from Telegram callback data', async () => {
  const workspaceRoot = createTempWorkspace();
  const scaffold = scaffoldWorkflow({
    workspaceRoot,
    workflowId: 'lobster-approval',
    displayName: 'Lobster Approval',
    description: 'Lobster approval workflow',
  });

  writeWorkflowConfig(scaffold.workflowRoot, `module.exports = {
  identity: {
    workflowId: 'lobster-approval',
    displayName: 'Lobster Approval',
    description: 'Lobster approval workflow',
  },
  runtime: {
    runnerType: 'lobster',
    entrypoint: 'lobster-approval.lobster',
    workingDirectory: '.',
    defaultInputs: {},
  },
  schedules: [],
  result: {
    resultType: 'object',
    resultDescription: 'Approval result',
    latestResultPolicy: 'on-success',
    extractor: {},
  },
  observability: {
    successCondition: {
      ok: true,
      status: 'ok',
    },
    defaultTimeoutMs: 30000,
  },
};
`);
  writeFile(path.join(scaffold.workflowRoot, 'lobster-approval.lobster'), 'name: lobster-approval\nsteps: []\n');
  const previewScriptPath = path.join(workspaceRoot, 'emit-approved.js');
  writeFile(previewScriptPath, 'process.stdout.write(JSON.stringify({ approved: true }));\n');
  const pipeline = `exec --json --shell 'node ${previewScriptPath.replace(/\\/g, '/')}' | approve --preview-from-stdin --prompt 'Upload package to Drive?'`;
  const lobsterRun = runCommand('lobster', ['run', '--mode', 'tool', pipeline], {
    cwd: scaffold.workflowRoot,
  });
  assert.equal(lobsterRun.ok, true, lobsterRun.stderr || lobsterRun.errorMessage);
  const envelope = JSON.parse(lobsterRun.stdout);
  assert.equal(envelope.status, 'needs_approval');
  assert.equal(Boolean(envelope.requiresApproval?.resumeToken), true);

  const executionId = '2026-03-18T12-00-00-000Z__lobster-approval__abc12345';
  const runPath = writeRunRecord({
    workspaceRoot,
    record: {
      executionId,
      workflowId: 'lobster-approval',
      workflowRoot: scaffold.workflowRoot.replace(/\\/g, '/'),
      runnerType: 'lobster',
      trigger: 'manual',
      scheduleId: null,
      scheduledFor: null,
      startedAt: '2026-03-18T12:00:00.000Z',
      finishedAt: '2026-03-18T12:00:01.000Z',
      status: 'awaiting_approval',
      result: null,
      error: null,
      process: null,
      envelope,
      approval: {
        status: 'pending',
        prompt: envelope.requiresApproval.prompt,
        items: envelope.requiresApproval.items,
        resumeToken: envelope.requiresApproval.resumeToken,
        callbackToken: 'abcabcabcabc',
        requestedAt: '2026-03-18T12:00:01.000Z',
        approvers: ['1234567890'],
        decision: null,
        decidedAt: null,
        notifications: [{
          channel: 'telegram',
          target: '1234567890',
          chatId: '1234567890',
          messageId: '63',
          deliveryStatus: 'sent',
          callbackApprove: '/lwf ap:abcabcabcabc',
          callbackReject: '/lwf rj:abcabcabcabc',
        }],
      },
    },
  });

  const originalFetch = global.fetch;
  const fetchCalls = [];
  global.fetch = async (url, options) => {
    fetchCalls.push({
      url: String(url),
      body: JSON.parse(options.body),
    });
    return {
      ok: true,
      text: async () => JSON.stringify({ ok: true, result: { message_id: 63 } }),
    };
  };

  try {
    const resumed = await resumeManagedWorkflow({
      workspaceRoot,
      callbackData: '/lwf ap:abcabcabcabc',
      senderId: '1234567890',
    });

    assert.equal(resumed.status, 'success');
    const record = JSON.parse(fs.readFileSync(runPath, 'utf8'));
    assert.equal(record.status, 'success');
    assert.equal(record.approval.decision, 'approve');
    assert.equal(record.result.output[0].approved, true);
    assert.equal(record.approval.notifications[0].resolutionDeliveryStatus, 'edited');
    assert.equal(resumed.editedNotificationCount, 1);
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].url, /editMessageText/);
    assert.equal(fetchCalls[0].body.parse_mode, 'HTML');
    assert.deepEqual(fetchCalls[0].body.reply_markup, { inline_keyboard: [] });
  } finally {
    global.fetch = originalFetch;
  }
});

test('resume-workflow rejects non-Telegram approval sources', async () => {
  const workspaceRoot = createTempWorkspace();
  const scaffold = scaffoldWorkflow({
    workspaceRoot,
    workflowId: 'approval-report',
    displayName: 'Approval Report',
    description: 'Approval workflow',
  });
  writeNodeWorkflowConfig(scaffold.workflowRoot, 'approval-report', 'Approval Report', 'Approval workflow');
  writeNodeApprovalRunner(scaffold.workflowRoot);

  const initial = await runManagedWorkflow({
    workspaceRoot,
    workflowId: 'approval-report',
    startedAt: '2026-03-18T12:00:00.000Z',
  });

  await assert.rejects(() => resumeManagedWorkflow({
    workspaceRoot,
    executionId: initial.executionId,
    decision: 'approve',
    via: 'chat',
  }), /only be resolved from Telegram inline buttons/);
});

test('resume-workflow rejects unauthorized Telegram senders', async () => {
  const workspaceRoot = createTempWorkspace();
  const scaffold = scaffoldWorkflow({
    workspaceRoot,
    workflowId: 'approval-report',
    displayName: 'Approval Report',
    description: 'Approval workflow',
  });
  writeNodeWorkflowConfig(scaffold.workflowRoot, 'approval-report', 'Approval Report', 'Approval workflow');
  writeNodeApprovalRunner(scaffold.workflowRoot);

  const initial = await runManagedWorkflow({
    workspaceRoot,
    workflowId: 'approval-report',
    startedAt: '2026-03-18T12:00:00.000Z',
    env: {
      ...process.env,
      LOBSTER_WORKFLOWS_TELEGRAM_APPROVERS: '1234567890',
    },
  });

  await assert.rejects(() => resumeManagedWorkflow({
    workspaceRoot,
    callbackData: initial.approval.notifications[0].callbackApprove,
    senderId: '9999999999',
  }), /not authorized/);
});
