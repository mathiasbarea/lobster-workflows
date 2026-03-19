#!/usr/bin/env node
const path = require('path');

const { ensureArg, normalizePath, parseArgs, printJson } = require('./_lib');
const { parseApprovalCallbackData, settleTelegramApprovalNotification } = require('./lib/approval-utils');
const {
  findPendingApprovalByCallbackToken,
  findRunRecordByExecutionId,
  writeLatestResult,
  writeRunRecord,
} = require('./lib/execution-store');
const { runCommand } = require('./lib/process-utils');
const {
  extractWorkflowResult,
  isCancelledEnvelope,
  isSuccessfulEnvelope,
} = require('./lib/result-extractor');
const { loadWorkflow } = require('./lib/workflow-loader');

function parseJsonOutput(stdout) {
  if (!stdout || !stdout.trim()) return null;
  return JSON.parse(stdout);
}

function resolveApprovalTarget({ workspaceRoot, flags }) {
  if (flags.callbackData) {
    const parsed = parseApprovalCallbackData(flags.callbackData);
    if (!parsed) {
      throw new Error('Invalid --callback-data value');
    }
    const record = findPendingApprovalByCallbackToken(workspaceRoot, parsed.callbackToken);
    if (!record) {
      throw new Error(`No pending workflow approval found for callback token ${parsed.callbackToken}`);
    }
    return {
      record,
      decision: parsed.action,
      source: 'telegram-inline',
      callbackToken: parsed.callbackToken,
      senderId: flags.senderId || null,
    };
  }

  const executionId = ensureArg(flags, 'execution-id');
  const decision = ensureArg(flags, 'decision');
  const via = ensureArg(flags, 'via');
  const record = findRunRecordByExecutionId(workspaceRoot, executionId);
  if (!record) {
    throw new Error(`Execution not found: ${executionId}`);
  }
  return {
    record,
    decision,
    source: via,
    callbackToken: null,
    senderId: flags.senderId || null,
  };
}

function isAuthorizedTelegramApprover(record, senderId) {
  if (!senderId) return true;
  const normalizedSenderId = String(senderId).trim();
  if (!normalizedSenderId) return true;
  const configuredApprovers = Array.isArray(record.approval?.approvers)
    ? record.approval.approvers
      .map((value) => String(value || '').trim())
      .filter(Boolean)
    : [];
  if (configuredApprovers.length > 0) {
    return configuredApprovers.includes(normalizedSenderId);
  }
  return (record.approval?.notifications || []).some((notification) => (
    notification?.channel === 'telegram'
      && [notification.target, notification.chatId]
        .filter(Boolean)
        .map((value) => String(value).trim())
        .includes(normalizedSenderId)
  ));
}

async function resumeManagedWorkflow({
  workspaceRoot,
  executionId = null,
  decision = null,
  via = null,
  callbackData = null,
  senderId = null,
  env = process.env,
}) {
  const flags = {
    executionId,
    decision,
    via,
    callbackData,
    senderId,
  };
  const target = resolveApprovalTarget({ workspaceRoot, flags });
  if (target.source !== 'telegram-inline') {
    throw new Error('Workflow approvals can only be resolved from Telegram inline buttons');
  }

  const current = target.record;
  if (current.status !== 'awaiting_approval' || !current.approval?.resumeToken) {
    throw new Error(`Execution ${current.executionId} is not awaiting approval`);
  }
  if (!isAuthorizedTelegramApprover(current, target.senderId)) {
    throw new Error('Telegram sender is not authorized to resolve this workflow approval');
  }

  const workflow = loadWorkflow(workspaceRoot, current.workflowId);
  if (workflow.config.runtime.runnerType !== 'lobster') {
    throw new Error(`Workflow ${current.workflowId} does not support Lobster resume`);
  }

  const lobsterBin = env.LOBSTER_WORKFLOWS_LOBSTER_BIN || 'lobster';
  const processResult = runCommand(lobsterBin, [
    'resume',
    '--token',
    current.approval.resumeToken,
    '--approve',
    target.decision === 'approve' ? 'yes' : 'no',
  ], {
    cwd: workflow.workflowRoot,
    env,
    timeoutMs: workflow.config.observability?.defaultTimeoutMs || 30000,
  });

  let envelope = null;
  let status = 'failed';
  let result = null;
  let error = null;

  try {
    envelope = parseJsonOutput(processResult.stdout);
  } catch (parseError) {
    error = {
      code: 'invalid_workflow_output',
      message: parseError.message,
    };
  }

  if (!error) {
    if (isCancelledEnvelope(envelope)) {
      status = 'cancelled';
    } else if (isSuccessfulEnvelope({
      config: workflow.config,
      envelope,
      processResult,
    })) {
      status = 'success';
      result = extractWorkflowResult({
        config: workflow.config,
        envelope,
      });
    } else {
      error = {
        code: envelope?.error?.code || 'workflow_failed',
        message: envelope?.error?.message || processResult.stderr || processResult.errorMessage || 'Workflow execution failed',
      };
    }
  }

  const finishedAt = new Date().toISOString();
  const settledNotifications = [];
  for (const notification of current.approval?.notifications || []) {
    settledNotifications.push(await settleTelegramApprovalNotification({
      workflow,
      executionId: current.executionId,
      decision: target.decision,
      status,
      error,
      notification,
      env,
    }));
  }

  const editedNotificationCount = settledNotifications
    .filter((notification) => notification?.resolutionDeliveryStatus === 'edited')
    .length;

  const updatedRecord = {
    ...current,
    finishedAt,
    status,
    result,
    error,
    envelope,
    approval: {
      ...current.approval,
      status: 'resolved',
      decision: target.decision,
      decidedAt: finishedAt,
      notifications: settledNotifications,
    },
    process: {
      command: lobsterBin,
      args: [
        'resume',
        '--token',
        current.approval.resumeToken,
        '--approve',
        target.decision === 'approve' ? 'yes' : 'no',
      ],
      cwd: normalizePath(workflow.workflowRoot),
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      durationMs: processResult.durationMs,
      timedOut: processResult.timedOut,
      stdoutTail: processResult.stdout || '',
      stderrTail: processResult.stderr || '',
    },
  };

  const runPath = writeRunRecord({ workspaceRoot, record: updatedRecord });
  let latestResultPath = null;
  if (status === 'success' && workflow.config.result?.latestResultPolicy !== 'never') {
    latestResultPath = writeLatestResult({
      workspaceRoot,
      workflowId: current.workflowId,
      payload: {
        workflowId: current.workflowId,
        executionId: current.executionId,
        updatedAt: finishedAt,
        status,
        trigger: current.trigger,
        scheduledFor: current.scheduledFor,
        result,
      },
    });
  }

  return {
    executionId: current.executionId,
    workflowId: current.workflowId,
    status,
    decision: target.decision,
    runPath: normalizePath(runPath),
    latestResultPath: latestResultPath ? normalizePath(latestResultPath) : null,
    result,
    error,
    editedNotificationCount,
  };
}

function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const workspaceRoot = path.resolve(flags.workspaceRoot || process.cwd());
  return resumeManagedWorkflow({
    workspaceRoot,
    executionId: flags.executionId || null,
    decision: flags.decision || null,
    via: flags.via || null,
    callbackData: flags.callbackData || null,
    senderId: flags.senderId || null,
  }).then(printJson);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  resumeManagedWorkflow,
};
