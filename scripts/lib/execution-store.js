const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { listJsonFiles, readJson, readJsonIfExists, writeJson } = require('./json-store');
const {
  getDailySummaryPath,
  getLatestResultPath,
  getRunRecordPath,
  getRunsRoot,
  getScheduleSnapshotPath,
  getSyncStatePath,
} = require('./paths');

function toDateKey(isoText) {
  return String(isoText).slice(0, 10);
}

function createExecutionId({ workflowId, startedAt }) {
  const stamp = String(startedAt).replace(/[:.]/g, '-');
  const suffix = crypto.randomBytes(4).toString('hex');
  return `${stamp}__${workflowId}__${suffix}`;
}

function writeRunRecord({ workspaceRoot, record }) {
  const dateKey = toDateKey(record.startedAt);
  const runPath = getRunRecordPath(workspaceRoot, dateKey, record.workflowId, record.executionId);
  writeJson(runPath, record);
  return runPath;
}

function listRunRecordsForDate(workspaceRoot, date) {
  const dayRoot = path.join(getRunsRoot(workspaceRoot), date);
  if (!fs.existsSync(dayRoot)) return [];

  return fs.readdirSync(dayRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => listJsonFiles(path.join(dayRoot, entry.name)))
    .map((filePath) => readJson(filePath));
}

function listRunRecordsForDates(workspaceRoot, dates) {
  return dates.flatMap((date) => listRunRecordsForDate(workspaceRoot, date));
}

function listAllRunRecords(workspaceRoot) {
  const runsRoot = getRunsRoot(workspaceRoot);
  if (!fs.existsSync(runsRoot)) return [];

  return fs.readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => listRunRecordsForDate(workspaceRoot, entry.name));
}

function findRunRecordByExecutionId(workspaceRoot, executionId) {
  return listAllRunRecords(workspaceRoot).find((record) => record.executionId === executionId) || null;
}

function findPendingApprovalByCallbackToken(workspaceRoot, callbackToken) {
  return listAllRunRecords(workspaceRoot).find((record) => (
    record.status === 'awaiting_approval' &&
    record.approval &&
    record.approval.callbackToken === callbackToken
  )) || null;
}

function listPendingApprovalRecords(workspaceRoot) {
  return listAllRunRecords(workspaceRoot)
    .filter((record) => record.status === 'awaiting_approval' && record.approval && record.approval.resumeToken)
    .sort((left, right) => String(left.startedAt).localeCompare(String(right.startedAt)));
}

function writeLatestResult({ workspaceRoot, workflowId, payload }) {
  const filePath = getLatestResultPath(workspaceRoot, workflowId);
  writeJson(filePath, payload);
  return filePath;
}

function readLatestResult(workspaceRoot, workflowId) {
  return readJsonIfExists(getLatestResultPath(workspaceRoot, workflowId), null);
}

function writeDailySummary({ workspaceRoot, date, summary }) {
  const filePath = getDailySummaryPath(workspaceRoot, date);
  writeJson(filePath, summary);
  return filePath;
}

function writeScheduleSnapshot({ workspaceRoot, date, snapshot }) {
  const filePath = getScheduleSnapshotPath(workspaceRoot, date);
  writeJson(filePath, snapshot);
  return filePath;
}

function writeSyncState({ workspaceRoot, workflowId, state }) {
  const filePath = getSyncStatePath(workspaceRoot, workflowId);
  writeJson(filePath, state);
  return filePath;
}

function readSyncState(workspaceRoot, workflowId) {
  return readJsonIfExists(getSyncStatePath(workspaceRoot, workflowId), null);
}

module.exports = {
  createExecutionId,
  findPendingApprovalByCallbackToken,
  findRunRecordByExecutionId,
  listAllRunRecords,
  listPendingApprovalRecords,
  listRunRecordsForDate,
  listRunRecordsForDates,
  readLatestResult,
  readSyncState,
  toDateKey,
  writeDailySummary,
  writeLatestResult,
  writeRunRecord,
  writeScheduleSnapshot,
  writeSyncState,
};
