#!/usr/bin/env node
const path = require('path');

const { normalizePath, parseArgs, printJson } = require('./_lib');
const { listPendingApprovalRecords } = require('./lib/execution-store');
const { loadWorkflow } = require('./lib/workflow-loader');

function listPendingApprovals({ workspaceRoot }) {
  return listPendingApprovalRecords(workspaceRoot).map((record) => {
    const workflow = loadWorkflow(workspaceRoot, record.workflowId);
    return {
      executionId: record.executionId,
      workflowId: record.workflowId,
      displayName: workflow.config.identity.displayName,
      workflowRoot: normalizePath(workflow.workflowRoot),
      trigger: record.trigger,
      scheduleId: record.scheduleId,
      scheduledFor: record.scheduledFor,
      startedAt: record.startedAt,
      requestedAt: record.approval?.requestedAt || record.finishedAt,
      prompt: record.approval?.prompt || '',
      approvers: Array.isArray(record.approval?.approvers) ? record.approval.approvers : [],
      itemsCount: Array.isArray(record.approval?.items) ? record.approval.items.length : 0,
      notificationStatus: Array.isArray(record.approval?.notifications)
        ? record.approval.notifications.map((entry) => ({
          channel: entry.channel,
          target: entry.target,
          deliveryStatus: entry.deliveryStatus,
        }))
        : [],
    };
  });
}

function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const workspaceRoot = path.resolve(flags.workspaceRoot || process.cwd());
  const approvals = listPendingApprovals({ workspaceRoot });
  printJson({
    workspaceRoot: normalizePath(workspaceRoot),
    count: approvals.length,
    approvals,
  });
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  listPendingApprovals,
};
