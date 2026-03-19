#!/usr/bin/env node
const path = require('path');

const { parseArgs, printJson } = require('./_lib');
const { syncWorkflowSchedules } = require('./lib/cron-sync');
const { listWorkflowIds, loadWorkflow } = require('./lib/workflow-loader');

function syncSchedules({
  workspaceRoot,
  workflowId = null,
  skillRoot = path.resolve(__dirname, '..'),
  syncBackend = 'auto',
  dryRun = false,
  openclawCommand = 'openclaw',
  openclawTimeoutMs = 30000,
  openclawRetryCount,
  openclawRetryDelayMs,
  runCommandFn,
  sleepFn,
}) {
  const targetWorkflowIds = workflowId ? [workflowId] : listWorkflowIds(workspaceRoot);
  const workflows = targetWorkflowIds.map((currentWorkflowId) => loadWorkflow(workspaceRoot, currentWorkflowId));
  const results = workflows.map((workflow) => syncWorkflowSchedules({
    workspaceRoot,
    workflow,
    skillRoot,
    syncBackend,
    dryRun,
    openclawCommand,
    openclawTimeoutMs,
    openclawRetryCount,
    openclawRetryDelayMs,
    runCommandFn,
    sleepFn,
  }));

  return {
    workspaceRoot,
    skillRoot,
    workflowCount: results.length,
    workflows: results,
  };
}

function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const workspaceRoot = path.resolve(flags.workspaceRoot || process.cwd());
  const result = syncSchedules({
    workspaceRoot,
    workflowId: flags.workflow || null,
    skillRoot: path.resolve(flags.skillRoot || path.resolve(__dirname, '..')),
    syncBackend: flags.syncBackend || 'auto',
    dryRun: Boolean(flags.dryRun),
    openclawCommand: flags.openclawCommand || 'openclaw',
    openclawTimeoutMs: flags.openclawTimeoutMs ? Number.parseInt(flags.openclawTimeoutMs, 10) : 30000,
    openclawRetryCount: flags.openclawRetryCount ? Number.parseInt(flags.openclawRetryCount, 10) : undefined,
    openclawRetryDelayMs: flags.openclawRetryDelayMs ? Number.parseInt(flags.openclawRetryDelayMs, 10) : undefined,
  });
  printJson(result);
  if (result.workflows.some((workflow) => workflow?.recoveryOnly === true)) {
    process.exitCode = 2;
  }
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
  syncSchedules,
};
