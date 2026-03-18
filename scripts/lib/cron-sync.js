const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { normalizePath } = require('../_lib');
const { runCommand } = require('./process-utils');
const { writeSyncState } = require('./execution-store');

const MANAGED_PREFIX = 'lobster-workflows::';
let cachedOpenclawCliScriptPath = null;

function getManagedJobName(workflowId, scheduleId) {
  return `${MANAGED_PREFIX}${workflowId}::${scheduleId}`;
}

function parseCronListJson(stdout) {
  const parsed = stdout && stdout.trim() ? JSON.parse(stdout) : {};
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.jobs)) return parsed.jobs;
  return [];
}

function parseCronAddJson(stdout) {
  const parsed = stdout && stdout.trim() ? JSON.parse(stdout) : {};
  return parsed.jobId || parsed.id || parsed?.job?.jobId || parsed?.job?.id || parsed?.result?.jobId || parsed?.result?.id || null;
}

function buildCronMessage({ skillRoot, workspaceRoot, workflowId, scheduleId }) {
  const scriptPath = normalizePath(path.join(skillRoot, 'scripts', 'run-workflow.js'));
  return [
    'Use the `lobster-workflows` skill.',
    `Run the managed workflow "${workflowId}" exactly once.`,
    'Execute this command:',
    `node "${scriptPath}" --workspace-root "${normalizePath(workspaceRoot)}" --workflow "${workflowId}" --trigger scheduled --schedule-id "${scheduleId}"`,
    'Return the resulting JSON envelope.',
  ].join('\n');
}

function buildCommonJobArgs({ workflow, schedule, skillRoot, workspaceRoot }) {
  const timeoutSeconds = Math.max(1, Math.ceil((workflow.config.observability?.defaultTimeoutMs || 30000) / 1000));
  return [
    '--name', getManagedJobName(workflow.workflowId, schedule.scheduleId),
    '--description', schedule.description || `${workflow.workflowId}:${schedule.scheduleId}`,
    '--session', 'isolated',
    '--message', buildCronMessage({
      skillRoot,
      workspaceRoot,
      workflowId: workflow.workflowId,
      scheduleId: schedule.scheduleId,
    }),
    '--no-deliver',
    '--light-context',
    '--timeout-seconds', String(timeoutSeconds),
  ];
}

function appendScheduleArgs(args, schedule) {
  if (schedule.kind === 'cron') {
    args.push('--cron', schedule.cron);
    if (schedule.timezone) args.push('--tz', schedule.timezone);
    if (schedule.stagger) args.push('--stagger', schedule.stagger);
    if (schedule.exact) args.push('--exact');
    return;
  }
  if (schedule.kind === 'every') {
    args.push('--every', schedule.every);
    return;
  }
  if (schedule.kind === 'at') {
    args.push('--at', schedule.at);
    if (schedule.deleteAfterRun !== false) args.push('--delete-after-run');
    else args.push('--keep-after-run');
    return;
  }
  throw new Error(`Unsupported schedule kind for sync: ${schedule.kind}`);
}

function resolveOpenclawCliScriptPath(openclawCommand) {
  if (cachedOpenclawCliScriptPath) return cachedOpenclawCliScriptPath;

  if (path.isAbsolute(openclawCommand) && openclawCommand.toLowerCase().endsWith('.cmd')) {
    const candidate = path.join(path.dirname(openclawCommand), 'node_modules', 'openclaw', 'openclaw.mjs');
    if (fs.existsSync(candidate)) {
      cachedOpenclawCliScriptPath = candidate;
      return candidate;
    }
  }

  const whereResult = spawnSync('where.exe', ['openclaw.cmd'], {
    encoding: 'utf8',
    stdio: 'pipe',
    shell: false,
    timeout: 10000,
  });
  if (whereResult.status !== 0 || !whereResult.stdout) {
    throw new Error(`Failed to resolve openclaw.cmd: ${whereResult.stderr || whereResult.error?.message || 'unknown error'}`);
  }

  const cmdPath = whereResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!cmdPath) {
    throw new Error('Failed to resolve openclaw.cmd from PATH');
  }

  const candidate = path.join(path.dirname(cmdPath), 'node_modules', 'openclaw', 'openclaw.mjs');
  if (!fs.existsSync(candidate)) {
    throw new Error(`Resolved openclaw.mjs does not exist: ${candidate}`);
  }

  cachedOpenclawCliScriptPath = candidate;
  return candidate;
}

function buildOpenclawInvocation(openclawCommand, args, runCommandFn) {
  if (process.platform !== 'win32' || runCommandFn !== runCommand) {
    return {
      command: openclawCommand,
      args,
      shell: true,
    };
  }

  const openclawScriptPath = resolveOpenclawCliScriptPath(openclawCommand);
  return {
    command: process.execPath,
    args: [openclawScriptPath, ...args],
    shell: false,
  };
}

function runOpenclawCommand({
  openclawCommand,
  args,
  workspaceRoot,
  openclawTimeoutMs,
  runCommandFn,
}) {
  const invocation = buildOpenclawInvocation(openclawCommand, args, runCommandFn);
  return runCommandFn(invocation.command, invocation.args, {
    cwd: workspaceRoot,
    timeoutMs: openclawTimeoutMs + 10000,
    shell: invocation.shell,
  });
}

function syncWorkflowSchedules({
  workspaceRoot,
  workflow,
  skillRoot,
  openclawCommand = 'openclaw',
  openclawTimeoutMs = 30000,
  runCommandFn = runCommand,
}) {
  const listResult = runOpenclawCommand({
    openclawCommand,
    args: ['cron', 'list', '--all', '--json', '--timeout', String(openclawTimeoutMs)],
    workspaceRoot,
    openclawTimeoutMs,
    runCommandFn,
  });
  if (!listResult.ok) {
    throw new Error(`Failed to list cron jobs: ${listResult.stderr || listResult.errorMessage || 'unknown error'}`);
  }

  const jobs = parseCronListJson(listResult.stdout);
  const existingManagedJobs = jobs.filter((job) => String(job.name || '').startsWith(`${MANAGED_PREFIX}${workflow.workflowId}::`));
  const activeSchedules = (workflow.config.schedules || []).filter((schedule) => schedule.enabled !== false && schedule.enabledByDefault !== false);
  const operations = [];
  const syncedSchedules = [];

  for (const schedule of activeSchedules) {
    const name = getManagedJobName(workflow.workflowId, schedule.scheduleId);
    const existingJob = existingManagedJobs.find((job) => job.name === name);
    if (!existingJob) {
      const addArgs = ['cron', 'add', ...buildCommonJobArgs({ workflow, schedule, skillRoot, workspaceRoot })];
      appendScheduleArgs(addArgs, schedule);
      addArgs.push('--json');
      addArgs.push('--timeout', String(openclawTimeoutMs));
      const addResult = runOpenclawCommand({
        openclawCommand,
        args: addArgs,
        workspaceRoot,
        openclawTimeoutMs,
        runCommandFn,
      });
      if (!addResult.ok) {
        throw new Error(`Failed to add cron job for ${workflow.workflowId}/${schedule.scheduleId}: ${addResult.stderr || addResult.errorMessage || 'unknown error'}`);
      }
      const jobId = parseCronAddJson(addResult.stdout);
      operations.push({ type: 'add', scheduleId: schedule.scheduleId, jobId });
      syncedSchedules.push({ scheduleId: schedule.scheduleId, jobId, jobName: name, enabled: true });
      continue;
    }

    const editArgs = ['cron', 'edit', existingJob.id || existingJob.jobId, ...buildCommonJobArgs({ workflow, schedule, skillRoot, workspaceRoot }), '--enable'];
    appendScheduleArgs(editArgs, schedule);
    editArgs.push('--timeout', String(openclawTimeoutMs));
    const editResult = runOpenclawCommand({
      openclawCommand,
      args: editArgs,
      workspaceRoot,
      openclawTimeoutMs,
      runCommandFn,
    });
    if (!editResult.ok) {
      throw new Error(`Failed to edit cron job for ${workflow.workflowId}/${schedule.scheduleId}: ${editResult.stderr || editResult.errorMessage || 'unknown error'}`);
    }
    operations.push({ type: 'edit', scheduleId: schedule.scheduleId, jobId: existingJob.id || existingJob.jobId });
    syncedSchedules.push({ scheduleId: schedule.scheduleId, jobId: existingJob.id || existingJob.jobId, jobName: name, enabled: true });
  }

  const activeScheduleIds = new Set(activeSchedules.map((schedule) => schedule.scheduleId));
  for (const job of existingManagedJobs) {
    const scheduleId = String(job.name).slice(`${MANAGED_PREFIX}${workflow.workflowId}::`.length);
    if (activeScheduleIds.has(scheduleId)) continue;
    const disableResult = runOpenclawCommand({
      openclawCommand,
      args: ['cron', 'disable', job.id || job.jobId, '--timeout', String(openclawTimeoutMs)],
      workspaceRoot,
      openclawTimeoutMs,
      runCommandFn,
    });
    if (!disableResult.ok) {
      throw new Error(`Failed to disable obsolete cron job ${job.id || job.jobId} for ${workflow.workflowId}/${scheduleId}`);
    }
    operations.push({ type: 'disable', scheduleId, jobId: job.id || job.jobId });
  }

  const state = {
    workflowId: workflow.workflowId,
    generatedAt: new Date().toISOString(),
    schedules: syncedSchedules,
    operations,
  };
  writeSyncState({
    workspaceRoot,
    workflowId: workflow.workflowId,
    state,
  });
  return state;
}

module.exports = {
  MANAGED_PREFIX,
  buildCronMessage,
  getManagedJobName,
  syncWorkflowSchedules,
};
