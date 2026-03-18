#!/usr/bin/env node
const path = require('path');

const { parseArgs, printJson } = require('./_lib');
const { syncWorkflowSchedules } = require('./lib/cron-sync');
const { listWorkflowIds, loadWorkflow } = require('./lib/workflow-loader');

function syncSchedules({
  workspaceRoot,
  workflowId = null,
  skillRoot = path.resolve(__dirname, '..'),
  openclawCommand = 'openclaw',
  openclawTimeoutMs = 30000,
  runCommandFn,
}) {
  const targetWorkflowIds = workflowId ? [workflowId] : listWorkflowIds(workspaceRoot);
  const workflows = targetWorkflowIds.map((currentWorkflowId) => loadWorkflow(workspaceRoot, currentWorkflowId));
  const results = workflows.map((workflow) => syncWorkflowSchedules({
    workspaceRoot,
    workflow,
    skillRoot,
    openclawCommand,
    openclawTimeoutMs,
    runCommandFn,
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
    openclawCommand: flags.openclawCommand || 'openclaw',
    openclawTimeoutMs: flags.openclawTimeoutMs ? Number.parseInt(flags.openclawTimeoutMs, 10) : 30000,
  });
  printJson(result);
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
