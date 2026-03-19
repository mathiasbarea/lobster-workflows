const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { normalizePath } = require('../_lib');
const {
  collectGatewayAccessDiagnostics,
  summarizeGatewayAccessDiagnostics,
} = require('./openclaw-health');
const { runCommand } = require('./process-utils');
const { writeSyncState } = require('./execution-store');

const MANAGED_PREFIX = 'lobster-workflows::';
const DEFAULT_OPENCLAW_RETRY_COUNT = 2;
const DEFAULT_OPENCLAW_RETRY_DELAY_MS = 750;
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

function parseDurationMs(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i);
  if (!match) return null;
  const quantity = Number.parseFloat(match[1] || '');
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const unit = String(match[2] || '').toLowerCase();
  const factor = unit === 'ms' ? 1
    : unit === 's' ? 1000
      : unit === 'm' ? 60 * 1000
        : unit === 'h' ? 60 * 60 * 1000
          : 24 * 60 * 60 * 1000;
  return Math.floor(quantity * factor);
}

function sleepSync(ms) {
  const delayMs = Number(ms);
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;

  if (typeof SharedArrayBuffer === 'function' && typeof Atomics?.wait === 'function') {
    const waitBuffer = new SharedArrayBuffer(4);
    const waitView = new Int32Array(waitBuffer);
    Atomics.wait(waitView, 0, 0, delayMs);
    return;
  }

  const endAt = Date.now() + delayMs;
  while (Date.now() < endAt) {
    // Busy wait is only used on runtimes without Atomics.wait support.
  }
}

function getCommandFailureDetails(result) {
  return String(result?.stderr || result?.stdout || result?.errorMessage || 'unknown error').trim();
}

function isTransientGatewayFailure(result) {
  if (!result || result.ok) return false;

  const details = getCommandFailureDetails(result).toLowerCase();
  if (!details) return false;

  if (result.timedOut && details.includes('gateway')) return true;

  return [
    'gateway connect failed',
    'gateway closed',
    'econnreset',
    'econnrefused',
    'etimedout',
    'socket hang up',
    'connection reset',
    'connection aborted',
    'unexpected eof',
  ].some((pattern) => details.includes(pattern));
}

function describeCommandFailure(result) {
  const details = getCommandFailureDetails(result);
  const attempts = Number(result?.attemptCount || 1);
  const retries = Number(result?.retryCount || 0);
  if (retries <= 0) return details;
  return `${details} (after ${attempts} attempts, ${retries} retries)`;
}

function buildOpenclawFailureMessage({
  prefix,
  result,
  workspaceRoot,
  openclawCommand,
  openclawTimeoutMs,
  runCommandFn,
}) {
  const details = describeCommandFailure(result);
  const shouldCollectDiagnostics = isTransientGatewayFailure(result) || /missing scope:/i.test(details);
  if (!shouldCollectDiagnostics) {
    return `${prefix}: ${details}`;
  }

  const diagnosticSummary = summarizeGatewayAccessDiagnostics(collectGatewayAccessDiagnostics({
    cwd: workspaceRoot,
    run: runCommandFn,
    openclawCommand,
    timeoutMs: Math.max(5000, Math.min(20000, openclawTimeoutMs)),
  }));
  if (!diagnosticSummary) {
    return `${prefix}: ${details}`;
  }

  return `${prefix}: ${details}. ${diagnosticSummary}`;
}

function isScheduleActive(schedule) {
  return Boolean(schedule) && schedule.enabled !== false && schedule.enabledByDefault !== false;
}

function parseManagedScheduleId(jobName, workflowId) {
  const prefix = `${MANAGED_PREFIX}${workflowId}::`;
  const normalized = String(jobName || '');
  if (!normalized.startsWith(prefix)) return null;
  return normalized.slice(prefix.length);
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
  openclawRetryCount = DEFAULT_OPENCLAW_RETRY_COUNT,
  openclawRetryDelayMs = DEFAULT_OPENCLAW_RETRY_DELAY_MS,
  sleepFn = sleepSync,
}) {
  const invocation = buildOpenclawInvocation(openclawCommand, args, runCommandFn);
  const maxRetries = Math.max(0, Number.isFinite(openclawRetryCount) ? Math.floor(openclawRetryCount) : DEFAULT_OPENCLAW_RETRY_COUNT);
  let attempt = 0;
  let lastResult = null;

  while (attempt <= maxRetries) {
    const result = runCommandFn(invocation.command, invocation.args, {
      cwd: workspaceRoot,
      timeoutMs: openclawTimeoutMs + 10000,
      shell: invocation.shell,
    });
    if (result.ok) {
      return {
        ...result,
        attemptCount: attempt + 1,
        retryCount: attempt,
      };
    }

    lastResult = result;
    if (!isTransientGatewayFailure(result) || attempt >= maxRetries) {
      return {
        ...result,
        attemptCount: attempt + 1,
        retryCount: attempt,
      };
    }

    const backoffMs = Math.max(0, Math.floor(openclawRetryDelayMs * (attempt + 1)));
    sleepFn(backoffMs);
    attempt += 1;
  }

  return {
    ...lastResult,
    attemptCount: maxRetries + 1,
    retryCount: maxRetries,
  };
}

function listCronJobs({
  workspaceRoot,
  openclawCommand = 'openclaw',
  openclawTimeoutMs = 30000,
  openclawRetryCount = DEFAULT_OPENCLAW_RETRY_COUNT,
  openclawRetryDelayMs = DEFAULT_OPENCLAW_RETRY_DELAY_MS,
  includeDisabled = true,
  runCommandFn = runCommand,
  sleepFn = sleepSync,
}) {
  const args = ['cron', 'list'];
  if (includeDisabled) args.push('--all');
  args.push('--json', '--timeout', String(openclawTimeoutMs));

  const listResult = runOpenclawCommand({
    openclawCommand,
    args,
    workspaceRoot,
    openclawTimeoutMs,
    runCommandFn,
    openclawRetryCount,
    openclawRetryDelayMs,
    sleepFn,
  });
  if (!listResult.ok) {
    throw new Error(buildOpenclawFailureMessage({
      prefix: 'Failed to list cron jobs',
      result: listResult,
      workspaceRoot,
      openclawCommand,
      openclawTimeoutMs,
      runCommandFn,
    }));
  }

  return parseCronListJson(listResult.stdout);
}

function buildExpectedManagedJob({ workflow, schedule, skillRoot, workspaceRoot }) {
  const timeoutSeconds = Math.max(1, Math.ceil((workflow.config.observability?.defaultTimeoutMs || 30000) / 1000));
  const expected = {
    name: getManagedJobName(workflow.workflowId, schedule.scheduleId),
    description: schedule.description || `${workflow.workflowId}:${schedule.scheduleId}`,
    enabled: true,
    sessionTarget: 'isolated',
    payload: {
      kind: 'agentTurn',
      message: buildCronMessage({
        skillRoot,
        workspaceRoot,
        workflowId: workflow.workflowId,
        scheduleId: schedule.scheduleId,
      }),
      timeoutSeconds,
    },
    schedule: {
      kind: schedule.kind,
    },
  };

  if (schedule.kind === 'cron') {
    expected.schedule.expr = schedule.cron;
    if (schedule.timezone) expected.schedule.tz = schedule.timezone;
    const staggerMs = schedule.exact ? 0 : parseDurationMs(schedule.stagger);
    if (staggerMs !== null) expected.schedule.staggerMs = staggerMs;
  } else if (schedule.kind === 'every') {
    expected.schedule.everyMs = parseDurationMs(schedule.every);
  } else if (schedule.kind === 'at') {
    const parsedAtMs = Date.parse(String(schedule.at || '').trim());
    expected.schedule.at = Number.isNaN(parsedAtMs) ? String(schedule.at || '').trim() : new Date(parsedAtMs).toISOString();
    expected.deleteAfterRun = schedule.deleteAfterRun !== false;
  }

  return expected;
}

function compareManagedJobs(actual, expected) {
  const mismatches = [];

  if (String(actual?.name || '') !== String(expected.name || '')) mismatches.push('name');
  if (String(actual?.description || '') !== String(expected.description || '')) mismatches.push('description');
  if (Boolean(actual?.enabled) !== Boolean(expected.enabled)) mismatches.push('enabled');
  if (String(actual?.sessionTarget || '') !== String(expected.sessionTarget || '')) mismatches.push('sessionTarget');
  if (String(actual?.payload?.kind || '') !== String(expected.payload?.kind || '')) mismatches.push('payload.kind');
  if (String(actual?.payload?.message || '') !== String(expected.payload?.message || '')) mismatches.push('payload.message');
  if (Number(actual?.payload?.timeoutSeconds || 0) !== Number(expected.payload?.timeoutSeconds || 0)) mismatches.push('payload.timeoutSeconds');
  if (String(actual?.schedule?.kind || '') !== String(expected.schedule?.kind || '')) mismatches.push('schedule.kind');

  const kind = expected.schedule?.kind;
  if (kind === 'cron') {
    if (String(actual?.schedule?.expr || '') !== String(expected.schedule?.expr || '')) mismatches.push('schedule.expr');
    if (String(actual?.schedule?.tz || '') !== String(expected.schedule?.tz || '')) mismatches.push('schedule.tz');
    const actualStagger = actual?.schedule?.staggerMs;
    const expectedStagger = expected.schedule?.staggerMs;
    if (actualStagger !== expectedStagger) mismatches.push('schedule.staggerMs');
  } else if (kind === 'every') {
    if (Number(actual?.schedule?.everyMs || 0) !== Number(expected.schedule?.everyMs || 0)) mismatches.push('schedule.everyMs');
  } else if (kind === 'at') {
    if (String(actual?.schedule?.at || '') !== String(expected.schedule?.at || '')) mismatches.push('schedule.at');
    if (Boolean(actual?.deleteAfterRun) !== Boolean(expected.deleteAfterRun)) mismatches.push('deleteAfterRun');
  }

  return mismatches;
}

function inspectWorkflowScheduleSync({
  workspaceRoot,
  workflow,
  skillRoot,
  jobs,
}) {
  const managedJobs = jobs.filter((job) => String(job?.name || '').startsWith(`${MANAGED_PREFIX}${workflow.workflowId}::`));
  const activeSchedules = (workflow.config.schedules || []).filter(isScheduleActive);
  const activeScheduleIds = new Set(activeSchedules.map((schedule) => schedule.scheduleId));
  const drift = [];

  for (const schedule of activeSchedules) {
    const expected = buildExpectedManagedJob({
      workflow,
      schedule,
      skillRoot,
      workspaceRoot,
    });
    const matchingJobs = managedJobs.filter((job) => String(job?.name || '') === expected.name);
    if (matchingJobs.length === 0) {
      drift.push({
        type: 'missing-active-job',
        scheduleId: schedule.scheduleId,
        expectedJobName: expected.name,
      });
      continue;
    }

    const enabledMatches = matchingJobs.filter((job) => job?.enabled !== false);
    if (enabledMatches.length > 1) {
      drift.push({
        type: 'duplicate-enabled-jobs',
        scheduleId: schedule.scheduleId,
        jobIds: enabledMatches.map((job) => job.id || job.jobId).filter(Boolean),
      });
    }

    const primaryJob = enabledMatches[0] || matchingJobs[0];
    if (primaryJob?.enabled === false) {
      drift.push({
        type: 'disabled-active-job',
        scheduleId: schedule.scheduleId,
        jobId: primaryJob.id || primaryJob.jobId || null,
      });
    }

    const mismatches = compareManagedJobs(primaryJob, expected);
    if (mismatches.length > 0) {
      drift.push({
        type: 'mismatched-job',
        scheduleId: schedule.scheduleId,
        jobId: primaryJob.id || primaryJob.jobId || null,
        fields: mismatches,
      });
    }
  }

  for (const job of managedJobs) {
    const scheduleId = parseManagedScheduleId(job?.name, workflow.workflowId);
    if (!scheduleId) continue;
    if (activeScheduleIds.has(scheduleId)) continue;
    if (job?.enabled === false) continue;
    drift.push({
      type: 'unexpected-enabled-job',
      scheduleId,
      jobId: job.id || job.jobId || null,
    });
  }

  return {
    workflowId: workflow.workflowId,
    activeScheduleCount: activeSchedules.length,
    managedJobCount: managedJobs.length,
    drift,
    inSync: drift.length === 0,
  };
}

function syncWorkflowSchedules({
  workspaceRoot,
  workflow,
  skillRoot,
  openclawCommand = 'openclaw',
  openclawTimeoutMs = 30000,
  openclawRetryCount = DEFAULT_OPENCLAW_RETRY_COUNT,
  openclawRetryDelayMs = DEFAULT_OPENCLAW_RETRY_DELAY_MS,
  runCommandFn = runCommand,
  sleepFn = sleepSync,
}) {
  const jobs = listCronJobs({
    workspaceRoot,
    openclawCommand,
    openclawTimeoutMs,
    openclawRetryCount,
    openclawRetryDelayMs,
    includeDisabled: true,
    runCommandFn,
    sleepFn,
  });
  const existingManagedJobs = jobs.filter((job) => String(job.name || '').startsWith(`${MANAGED_PREFIX}${workflow.workflowId}::`));
  const activeSchedules = (workflow.config.schedules || []).filter(isScheduleActive);
  const operations = [];
  const syncedSchedules = [];

  for (const schedule of activeSchedules) {
    const name = getManagedJobName(workflow.workflowId, schedule.scheduleId);
    const matchingJobs = existingManagedJobs.filter((job) => job.name === name);
    const existingJob = matchingJobs.find((job) => job.enabled !== false) || matchingJobs[0] || null;
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
        openclawRetryCount,
        openclawRetryDelayMs,
        sleepFn,
      });
      if (!addResult.ok) {
        throw new Error(buildOpenclawFailureMessage({
          prefix: `Failed to add cron job for ${workflow.workflowId}/${schedule.scheduleId}`,
          result: addResult,
          workspaceRoot,
          openclawCommand,
          openclawTimeoutMs,
          runCommandFn,
        }));
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
      openclawRetryCount,
      openclawRetryDelayMs,
      sleepFn,
    });
    if (!editResult.ok) {
      throw new Error(buildOpenclawFailureMessage({
        prefix: `Failed to edit cron job for ${workflow.workflowId}/${schedule.scheduleId}`,
        result: editResult,
        workspaceRoot,
        openclawCommand,
        openclawTimeoutMs,
        runCommandFn,
      }));
    }
    operations.push({ type: 'edit', scheduleId: schedule.scheduleId, jobId: existingJob.id || existingJob.jobId });
    syncedSchedules.push({ scheduleId: schedule.scheduleId, jobId: existingJob.id || existingJob.jobId, jobName: name, enabled: true });

    for (const duplicateJob of matchingJobs) {
      const duplicateJobId = duplicateJob.id || duplicateJob.jobId;
      const primaryJobId = existingJob.id || existingJob.jobId;
      if (!duplicateJobId || duplicateJobId === primaryJobId || duplicateJob.enabled === false) continue;
      const duplicateDisableResult = runOpenclawCommand({
        openclawCommand,
        args: ['cron', 'disable', duplicateJobId, '--timeout', String(openclawTimeoutMs)],
        workspaceRoot,
        openclawTimeoutMs,
        runCommandFn,
        openclawRetryCount,
        openclawRetryDelayMs,
        sleepFn,
      });
      if (!duplicateDisableResult.ok) {
        throw new Error(buildOpenclawFailureMessage({
          prefix: `Failed to disable duplicate cron job ${duplicateJobId} for ${workflow.workflowId}/${schedule.scheduleId}`,
          result: duplicateDisableResult,
          workspaceRoot,
          openclawCommand,
          openclawTimeoutMs,
          runCommandFn,
        }));
      }
      operations.push({ type: 'disable-duplicate', scheduleId: schedule.scheduleId, jobId: duplicateJobId });
    }
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
      openclawRetryCount,
      openclawRetryDelayMs,
      sleepFn,
    });
    if (!disableResult.ok) {
      throw new Error(buildOpenclawFailureMessage({
        prefix: `Failed to disable obsolete cron job ${job.id || job.jobId} for ${workflow.workflowId}/${scheduleId}`,
        result: disableResult,
        workspaceRoot,
        openclawCommand,
        openclawTimeoutMs,
        runCommandFn,
      }));
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
  buildExpectedManagedJob,
  compareManagedJobs,
  getManagedJobName,
  inspectWorkflowScheduleSync,
  isScheduleActive,
  listCronJobs,
  parseCronListJson,
  parseDurationMs,
  parseManagedScheduleId,
  isTransientGatewayFailure,
  syncWorkflowSchedules,
};
