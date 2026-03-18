#!/usr/bin/env node
const path = require('path');

const { ensureArg, parseArgs, printJson } = require('./_lib');
const {
  listRunRecordsForDates,
  readLatestResult,
  writeDailySummary,
  writeScheduleSnapshot,
} = require('./lib/execution-store');
const { expandScheduleOccurrencesForDate, shiftDate } = require('./lib/schedule-engine');
const { listWorkflowIds, loadWorkflow } = require('./lib/workflow-loader');

function summarizeOccurrenceRuns(runs) {
  if (runs.some((run) => run.status === 'success')) return 'success';
  if (runs.some((run) => run.status === 'failed')) return 'failed';
  if (runs.some((run) => run.status === 'abandoned' || run.status === 'running')) return 'abandoned';
  return 'missed';
}

function rebuildDailySummary({ workspaceRoot, date }) {
  const workflows = listWorkflowIds(workspaceRoot).map((workflowId) => loadWorkflow(workspaceRoot, workflowId));
  const runs = listRunRecordsForDates(workspaceRoot, [shiftDate(date, -1), date, shiftDate(date, 1)]);
  const scheduleSnapshot = [];
  const workflowSummaries = {};

  for (const workflow of workflows) {
    const expectedOccurrences = (workflow.config.schedules || [])
      .flatMap((schedule) => expandScheduleOccurrencesForDate(workflow.workflowId, schedule, date))
      .filter((occurrence) => occurrence.countsTowardExpected);

    scheduleSnapshot.push(...expectedOccurrences);

    const workflowRuns = runs.filter((run) => run.workflowId === workflow.workflowId);
    const manualRuns = workflowRuns.filter((run) => !run.scheduleId || !run.scheduledFor);

    let startedRuns = 0;
    let successfulRuns = 0;
    let failedRuns = 0;
    let abandonedRuns = 0;
    let missedRuns = 0;

    for (const occurrence of expectedOccurrences) {
      const occurrenceRuns = workflowRuns.filter((run) => run.scheduleId === occurrence.scheduleId && run.scheduledFor === occurrence.dueAt);
      if (occurrenceRuns.length > 0) startedRuns += 1;
      const status = summarizeOccurrenceRuns(occurrenceRuns);
      if (status === 'success') successfulRuns += 1;
      else if (status === 'failed') failedRuns += 1;
      else if (status === 'abandoned') abandonedRuns += 1;
      else missedRuns += 1;
    }

    workflowSummaries[workflow.workflowId] = {
      workflowId: workflow.workflowId,
      displayName: workflow.config.identity.displayName,
      expectedRuns: expectedOccurrences.length,
      startedRuns,
      successfulRuns,
      failedRuns,
      abandonedRuns,
      missedRuns,
      manualRuns: manualRuns.length,
      latestResult: readLatestResult(workspaceRoot, workflow.workflowId),
    };
  }

  const entries = Object.values(workflowSummaries);
  const summary = {
    date,
    generatedAt: new Date().toISOString(),
    expectedRuns: entries.reduce((total, entry) => total + entry.expectedRuns, 0),
    expectedWorkflows: entries.filter((entry) => entry.expectedRuns > 0).length,
    startedRuns: entries.reduce((total, entry) => total + entry.startedRuns, 0),
    startedWorkflows: entries.filter((entry) => entry.startedRuns > 0 || entry.manualRuns > 0).length,
    successfulRuns: entries.reduce((total, entry) => total + entry.successfulRuns, 0),
    failedRuns: entries.reduce((total, entry) => total + entry.failedRuns, 0),
    abandonedRuns: entries.reduce((total, entry) => total + entry.abandonedRuns, 0),
    missedRuns: entries.reduce((total, entry) => total + entry.missedRuns, 0),
    manualRuns: entries.reduce((total, entry) => total + entry.manualRuns, 0),
    workflows: workflowSummaries,
  };

  const scheduleSnapshotPath = writeScheduleSnapshot({
    workspaceRoot,
    date,
    snapshot: {
      date,
      generatedAt: summary.generatedAt,
      occurrences: scheduleSnapshot,
    },
  });

  const summaryPath = writeDailySummary({
    workspaceRoot,
    date,
    summary,
  });

  return {
    summaryPath,
    scheduleSnapshotPath,
    summary,
  };
}

function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const workspaceRoot = path.resolve(flags.workspaceRoot || process.cwd());
  const date = ensureArg(flags, 'date');
  const result = rebuildDailySummary({ workspaceRoot, date });
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
  rebuildDailySummary,
};
