const path = require('path');

function getWorkflowsRoot(workspaceRoot) {
  return path.join(workspaceRoot, 'workflows');
}

function getSharedRoot(workspaceRoot) {
  return path.join(getWorkflowsRoot(workspaceRoot), '_shared');
}

function getExecutionsRoot(workspaceRoot) {
  return path.join(getWorkflowsRoot(workspaceRoot), '_executions');
}

function getRunsRoot(workspaceRoot) {
  return path.join(getExecutionsRoot(workspaceRoot), 'runs');
}

function getDailyRoot(workspaceRoot) {
  return path.join(getExecutionsRoot(workspaceRoot), 'daily');
}

function getLatestRoot(workspaceRoot) {
  return path.join(getExecutionsRoot(workspaceRoot), 'latest');
}

function getSchedulesRoot(workspaceRoot) {
  return path.join(getExecutionsRoot(workspaceRoot), 'schedules');
}

function getSyncRoot(workspaceRoot) {
  return path.join(getExecutionsRoot(workspaceRoot), 'sync');
}

function getWorkflowRoot(workspaceRoot, workflowId) {
  return path.join(getWorkflowsRoot(workspaceRoot), workflowId);
}

function getWorkflowConfigPath(workspaceRoot, workflowId) {
  return path.join(getWorkflowRoot(workspaceRoot, workflowId), 'workflow.config.js');
}

function getWorkflowRunDayDir(workspaceRoot, date, workflowId) {
  return path.join(getRunsRoot(workspaceRoot), date, workflowId);
}

function getRunRecordPath(workspaceRoot, date, workflowId, executionId) {
  return path.join(getWorkflowRunDayDir(workspaceRoot, date, workflowId), `${executionId}.json`);
}

function getLatestResultPath(workspaceRoot, workflowId) {
  return path.join(getLatestRoot(workspaceRoot), `${workflowId}.json`);
}

function getDailySummaryPath(workspaceRoot, date) {
  return path.join(getDailyRoot(workspaceRoot), `${date}.json`);
}

function getScheduleSnapshotPath(workspaceRoot, date) {
  return path.join(getSchedulesRoot(workspaceRoot), `${date}.json`);
}

function getSyncStatePath(workspaceRoot, workflowId) {
  return path.join(getSyncRoot(workspaceRoot), `${workflowId}.json`);
}

module.exports = {
  getDailySummaryPath,
  getExecutionsRoot,
  getLatestResultPath,
  getLatestRoot,
  getRunRecordPath,
  getRunsRoot,
  getScheduleSnapshotPath,
  getSchedulesRoot,
  getSharedRoot,
  getSyncRoot,
  getSyncStatePath,
  getWorkflowConfigPath,
  getWorkflowRoot,
  getWorkflowRunDayDir,
  getWorkflowsRoot,
};
