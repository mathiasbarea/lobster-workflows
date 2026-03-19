const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { normalizePath } = require('../_lib');
const { parseJsonFromMixedStdout } = require('./approval-utils');
const {
  collectGatewayAccessDiagnostics,
  summarizeGatewayAccessDiagnostics,
} = require('./openclaw-health');
const { runCommand } = require('./process-utils');
const {
  readSyncState,
  writeSyncState,
} = require('./execution-store');

const MANAGED_PREFIX = 'lobster-workflows::';
const DEFAULT_SYNC_BACKEND = 'auto';
const DEFAULT_OPENCLAW_RETRY_COUNT = 2;
const DEFAULT_OPENCLAW_RETRY_DELAY_MS = 750;
const SYNC_BACKENDS = new Set(['auto', 'cli', 'gateway']);
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

function extractCronJobId(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  return parsed.jobId || parsed.id || parsed?.job?.jobId || parsed?.job?.id || parsed?.result?.jobId || parsed?.result?.id || null;
}

function parseCronAddJson(stdout) {
  const parsed = stdout && stdout.trim() ? JSON.parse(stdout) : {};
  return extractCronJobId(parsed);
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

function normalizeSyncBackend(syncBackend = DEFAULT_SYNC_BACKEND) {
  const normalized = String(syncBackend || DEFAULT_SYNC_BACKEND).trim().toLowerCase();
  if (!SYNC_BACKENDS.has(normalized)) {
    throw new Error(`Unsupported sync backend: ${syncBackend}`);
  }
  return normalized;
}

function parseOpenclawJson(stdout) {
  const parsed = parseJsonFromMixedStdout(stdout);
  if (parsed != null) return parsed;
  const text = String(stdout || '').trim();
  return text ? JSON.parse(text) : {};
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

function buildGatewaySchedule(schedule) {
  if (schedule.kind === 'cron') {
    const gatewaySchedule = {
      kind: 'cron',
      expr: schedule.cron,
    };
    if (schedule.timezone) gatewaySchedule.tz = schedule.timezone;
    if (schedule.exact) gatewaySchedule.staggerMs = 0;
    else if (schedule.stagger) gatewaySchedule.staggerMs = parseDurationMs(schedule.stagger);
    return gatewaySchedule;
  }

  if (schedule.kind === 'every') {
    return {
      kind: 'every',
      everyMs: parseDurationMs(schedule.every),
    };
  }

  if (schedule.kind === 'at') {
    const parsedAtMs = Date.parse(String(schedule.at || '').trim());
    return {
      kind: 'at',
      at: Number.isNaN(parsedAtMs) ? String(schedule.at || '').trim() : new Date(parsedAtMs).toISOString(),
    };
  }

  throw new Error(`Unsupported schedule kind for sync: ${schedule.kind}`);
}

function buildGatewayJobCreate({ workflow, schedule, skillRoot, workspaceRoot }) {
  const timeoutSeconds = Math.max(1, Math.ceil((workflow.config.observability?.defaultTimeoutMs || 30000) / 1000));
  const jobCreate = {
    name: getManagedJobName(workflow.workflowId, schedule.scheduleId),
    description: schedule.description || `${workflow.workflowId}:${schedule.scheduleId}`,
    enabled: true,
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: {
      kind: 'agentTurn',
      message: buildCronMessage({
        skillRoot,
        workspaceRoot,
        workflowId: workflow.workflowId,
        scheduleId: schedule.scheduleId,
      }),
      timeoutSeconds,
      lightContext: true,
    },
    delivery: {
      mode: 'none',
    },
    schedule: buildGatewaySchedule(schedule),
  };

  if (schedule.kind === 'at') {
    jobCreate.deleteAfterRun = schedule.deleteAfterRun !== false;
  }

  return jobCreate;
}

function buildGatewayJobPatch({ workflow, schedule, skillRoot, workspaceRoot }) {
  const jobCreate = buildGatewayJobCreate({
    workflow,
    schedule,
    skillRoot,
    workspaceRoot,
  });

  const patch = {
    name: jobCreate.name,
    description: jobCreate.description,
    enabled: jobCreate.enabled,
    sessionTarget: jobCreate.sessionTarget,
    wakeMode: jobCreate.wakeMode,
    payload: jobCreate.payload,
    delivery: jobCreate.delivery,
    schedule: jobCreate.schedule,
  };

  if (Object.prototype.hasOwnProperty.call(jobCreate, 'deleteAfterRun')) {
    patch.deleteAfterRun = jobCreate.deleteAfterRun;
  }

  return patch;
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

function buildGatewayCallArgs(method, params, openclawTimeoutMs) {
  return [
    'gateway',
    'call',
    method,
    '--json',
    '--params',
    JSON.stringify(params || {}),
    '--timeout',
    String(Math.max(10000, openclawTimeoutMs)),
  ];
}

function runGatewayMethod({
  method,
  params,
  openclawCommand,
  workspaceRoot,
  openclawTimeoutMs,
  runCommandFn,
  openclawRetryCount = DEFAULT_OPENCLAW_RETRY_COUNT,
  openclawRetryDelayMs = DEFAULT_OPENCLAW_RETRY_DELAY_MS,
  sleepFn = sleepSync,
}) {
  return runOpenclawCommand({
    openclawCommand,
    args: buildGatewayCallArgs(method, params, openclawTimeoutMs),
    workspaceRoot,
    openclawTimeoutMs,
    runCommandFn,
    openclawRetryCount,
    openclawRetryDelayMs,
    sleepFn,
  });
}

function listCronJobsViaCli({
  workspaceRoot,
  openclawCommand = 'openclaw',
  openclawTimeoutMs = 30000,
  includeDisabled = true,
  runCommandFn = runCommand,
  openclawRetryCount = DEFAULT_OPENCLAW_RETRY_COUNT,
  openclawRetryDelayMs = DEFAULT_OPENCLAW_RETRY_DELAY_MS,
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
      prefix: 'Failed to list cron jobs via cli backend',
      result: listResult,
      workspaceRoot,
      openclawCommand,
      openclawTimeoutMs,
      runCommandFn,
    }));
  }

  return parseCronListJson(listResult.stdout);
}

function listCronJobsViaGateway({
  workspaceRoot,
  openclawCommand = 'openclaw',
  openclawTimeoutMs = 30000,
  includeDisabled = true,
  runCommandFn = runCommand,
  openclawRetryCount = DEFAULT_OPENCLAW_RETRY_COUNT,
  openclawRetryDelayMs = DEFAULT_OPENCLAW_RETRY_DELAY_MS,
  sleepFn = sleepSync,
}) {
  const jobs = [];
  let offset = 0;
  let hasMore = true;
  while (hasMore) {
    const listResult = runGatewayMethod({
      method: 'cron.list',
      params: {
        includeDisabled,
        offset,
      },
      openclawCommand,
      workspaceRoot,
      openclawTimeoutMs,
      runCommandFn,
      openclawRetryCount,
      openclawRetryDelayMs,
      sleepFn,
    });
    if (!listResult.ok) {
      throw new Error(buildOpenclawFailureMessage({
        prefix: 'Failed to list cron jobs via gateway backend',
        result: listResult,
        workspaceRoot,
        openclawCommand,
        openclawTimeoutMs,
        runCommandFn,
      }));
    }

    const parsed = parseOpenclawJson(listResult.stdout);
    const pageJobs = Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    jobs.push(...pageJobs);
    hasMore = parsed?.hasMore === true;
    offset = typeof parsed?.nextOffset === 'number' ? parsed.nextOffset : jobs.length;
    if (!hasMore) break;
  }

  return jobs;
}

function listCronJobsResolved({
  workspaceRoot,
  openclawCommand = 'openclaw',
  openclawTimeoutMs = 30000,
  syncBackend = DEFAULT_SYNC_BACKEND,
  includeDisabled = true,
  runCommandFn = runCommand,
  openclawRetryCount = DEFAULT_OPENCLAW_RETRY_COUNT,
  openclawRetryDelayMs = DEFAULT_OPENCLAW_RETRY_DELAY_MS,
  sleepFn = sleepSync,
}) {
  const normalizedBackend = normalizeSyncBackend(syncBackend);
  if (normalizedBackend === 'cli') {
    return {
      jobs: listCronJobsViaCli({
        workspaceRoot,
        openclawCommand,
        openclawTimeoutMs,
        includeDisabled,
        runCommandFn,
        openclawRetryCount,
        openclawRetryDelayMs,
        sleepFn,
      }),
      selectedBackend: 'cli',
      backendAttempts: [{ backend: 'cli', ok: true }],
    };
  }

  if (normalizedBackend === 'gateway') {
    return {
      jobs: listCronJobsViaGateway({
        workspaceRoot,
        openclawCommand,
        openclawTimeoutMs,
        includeDisabled,
        runCommandFn,
        openclawRetryCount,
        openclawRetryDelayMs,
        sleepFn,
      }),
      selectedBackend: 'gateway',
      backendAttempts: [{ backend: 'gateway', ok: true }],
    };
  }

  try {
    const jobs = listCronJobsViaCli({
      workspaceRoot,
      openclawCommand,
      openclawTimeoutMs,
      includeDisabled,
      runCommandFn,
      openclawRetryCount,
      openclawRetryDelayMs,
      sleepFn,
    });
    return {
      jobs,
      selectedBackend: 'cli',
      backendAttempts: [{ backend: 'cli', ok: true }],
    };
  } catch (cliError) {
    const attempts = [{
      backend: 'cli',
      ok: false,
      error: cliError.message || String(cliError),
    }];
    try {
      const jobs = listCronJobsViaGateway({
        workspaceRoot,
        openclawCommand,
        openclawTimeoutMs,
        includeDisabled,
        runCommandFn,
        openclawRetryCount,
        openclawRetryDelayMs,
        sleepFn,
      });
      attempts.push({ backend: 'gateway', ok: true });
      return {
        jobs,
        selectedBackend: 'gateway',
        backendAttempts: attempts,
      };
    } catch (gatewayError) {
      attempts.push({
        backend: 'gateway',
        ok: false,
        error: gatewayError.message || String(gatewayError),
      });
      const cliMessage = cliError.message || String(cliError);
      const gatewayMessage = gatewayError.message || String(gatewayError);
      const combined = new Error(`Failed to list cron jobs via auto backend. CLI error: ${cliMessage}. Gateway error: ${gatewayMessage}`);
      combined.backendAttempts = attempts;
      throw combined;
    }
  }
}

function listCronJobs({
  workspaceRoot,
  openclawCommand = 'openclaw',
  openclawTimeoutMs = 30000,
  syncBackend = DEFAULT_SYNC_BACKEND,
  openclawRetryCount = DEFAULT_OPENCLAW_RETRY_COUNT,
  openclawRetryDelayMs = DEFAULT_OPENCLAW_RETRY_DELAY_MS,
  includeDisabled = true,
  runCommandFn = runCommand,
  sleepFn = sleepSync,
}) {
  return listCronJobsResolved({
    workspaceRoot,
    openclawCommand,
    openclawTimeoutMs,
    syncBackend,
    openclawRetryCount,
    openclawRetryDelayMs,
    includeDisabled,
    runCommandFn,
    sleepFn,
  }).jobs;
}

function buildOperationRemediation({
  operation,
  openclawCommand,
  openclawTimeoutMs,
}) {
  return {
    cli: {
      command: openclawCommand,
      args: operation.cliArgs,
    },
    gateway: {
      command: openclawCommand,
      args: buildGatewayCallArgs(operation.gatewayMethod, operation.gatewayParams, openclawTimeoutMs),
      method: operation.gatewayMethod,
      params: operation.gatewayParams,
    },
  };
}

function buildAddOperation({
  workflow,
  schedule,
  skillRoot,
  workspaceRoot,
  openclawCommand,
  openclawTimeoutMs,
}) {
  const cliArgs = ['cron', 'add', ...buildCommonJobArgs({ workflow, schedule, skillRoot, workspaceRoot })];
  appendScheduleArgs(cliArgs, schedule);
  cliArgs.push('--json');
  cliArgs.push('--timeout', String(openclawTimeoutMs));

  const operation = {
    type: 'add',
    scheduleId: schedule.scheduleId,
    jobId: null,
    jobName: getManagedJobName(workflow.workflowId, schedule.scheduleId),
    cliArgs,
    gatewayMethod: 'cron.add',
    gatewayParams: buildGatewayJobCreate({ workflow, schedule, skillRoot, workspaceRoot }),
    applied: false,
  };
  operation.remediation = buildOperationRemediation({
    operation,
    openclawCommand,
    openclawTimeoutMs,
  });
  return operation;
}

function buildEditOperation({
  workflow,
  schedule,
  existingJob,
  skillRoot,
  workspaceRoot,
  openclawCommand,
  openclawTimeoutMs,
}) {
  const jobId = existingJob.id || existingJob.jobId || null;
  const cliArgs = ['cron', 'edit', jobId, ...buildCommonJobArgs({ workflow, schedule, skillRoot, workspaceRoot }), '--enable'];
  appendScheduleArgs(cliArgs, schedule);
  cliArgs.push('--timeout', String(openclawTimeoutMs));

  const operation = {
    type: 'edit',
    scheduleId: schedule.scheduleId,
    jobId,
    jobName: getManagedJobName(workflow.workflowId, schedule.scheduleId),
    cliArgs,
    gatewayMethod: 'cron.update',
    gatewayParams: {
      id: jobId,
      patch: buildGatewayJobPatch({ workflow, schedule, skillRoot, workspaceRoot }),
    },
    applied: false,
  };
  operation.remediation = buildOperationRemediation({
    operation,
    openclawCommand,
    openclawTimeoutMs,
  });
  return operation;
}

function buildDisableOperation({
  workflow,
  scheduleId,
  jobId,
  type = 'disable',
  openclawCommand,
  openclawTimeoutMs,
}) {
  const operation = {
    type,
    scheduleId,
    jobId,
    cliArgs: ['cron', 'disable', jobId, '--timeout', String(openclawTimeoutMs)],
    gatewayMethod: 'cron.update',
    gatewayParams: {
      id: jobId,
      patch: { enabled: false },
    },
    applied: false,
  };
  operation.remediation = buildOperationRemediation({
    operation,
    openclawCommand,
    openclawTimeoutMs,
  });
  return operation;
}

function buildWorkflowSyncPlan({
  workspaceRoot,
  workflow,
  skillRoot,
  jobs,
  openclawCommand,
  openclawTimeoutMs,
}) {
  const existingManagedJobs = jobs.filter((job) => String(job.name || '').startsWith(`${MANAGED_PREFIX}${workflow.workflowId}::`));
  const activeSchedules = (workflow.config.schedules || []).filter(isScheduleActive);
  const operations = [];
  const syncedSchedules = [];

  for (const schedule of activeSchedules) {
    const name = getManagedJobName(workflow.workflowId, schedule.scheduleId);
    const matchingJobs = existingManagedJobs.filter((job) => job.name === name);
    const existingJob = matchingJobs.find((job) => job.enabled !== false) || matchingJobs[0] || null;
    if (!existingJob) {
      operations.push(buildAddOperation({
        workflow,
        schedule,
        skillRoot,
        workspaceRoot,
        openclawCommand,
        openclawTimeoutMs,
      }));
      syncedSchedules.push({ scheduleId: schedule.scheduleId, jobId: null, jobName: name, enabled: true });
      continue;
    }

    operations.push(buildEditOperation({
      workflow,
      schedule,
      existingJob,
      skillRoot,
      workspaceRoot,
      openclawCommand,
      openclawTimeoutMs,
    }));
    syncedSchedules.push({
      scheduleId: schedule.scheduleId,
      jobId: existingJob.id || existingJob.jobId || null,
      jobName: name,
      enabled: true,
    });

    for (const duplicateJob of matchingJobs) {
      const duplicateJobId = duplicateJob.id || duplicateJob.jobId;
      const primaryJobId = existingJob.id || existingJob.jobId;
      if (!duplicateJobId || duplicateJobId === primaryJobId || duplicateJob.enabled === false) continue;
      operations.push(buildDisableOperation({
        workflow,
        scheduleId: schedule.scheduleId,
        jobId: duplicateJobId,
        type: 'disable-duplicate',
        openclawCommand,
        openclawTimeoutMs,
      }));
    }
  }

  const activeScheduleIds = new Set(activeSchedules.map((schedule) => schedule.scheduleId));
  for (const job of existingManagedJobs) {
    const scheduleId = String(job.name).slice(`${MANAGED_PREFIX}${workflow.workflowId}::`.length);
    if (activeScheduleIds.has(scheduleId)) continue;
    const jobId = job.id || job.jobId;
    if (!jobId) continue;
    operations.push(buildDisableOperation({
      workflow,
      scheduleId,
      jobId,
      type: 'disable',
      openclawCommand,
      openclawTimeoutMs,
    }));
  }

  return {
    operations,
    syncedSchedules,
  };
}

function cloneJsonValue(value) {
  if (value == null) return null;
  return JSON.parse(JSON.stringify(value));
}

function getLastSuccessfulSyncState(syncState) {
  if (!syncState || typeof syncState !== 'object') return null;
  if (!syncState.status || syncState.status === 'synced') return syncState;
  if (syncState.lastSuccessfulState && typeof syncState.lastSuccessfulState === 'object') {
    return syncState.lastSuccessfulState;
  }
  return null;
}

function summarizeSuccessfulSyncState(syncState) {
  const successfulState = getLastSuccessfulSyncState(syncState);
  if (!successfulState) return null;
  return {
    generatedAt: successfulState.generatedAt || null,
    selectedBackend: successfulState.selectedBackend || successfulState.requestedBackend || null,
    scheduleCount: Array.isArray(successfulState.schedules) ? successfulState.schedules.length : 0,
  };
}

function buildPersistedSyncState({
  workflow,
  status,
  requestedBackend,
  selectedBackend,
  backendAttempts,
  dryRun,
  recoveryOnly,
  error,
  recovery,
  schedules,
  operations,
  lastSuccessfulState = null,
}) {
  return {
    workflowId: workflow.workflowId,
    generatedAt: new Date().toISOString(),
    status,
    requestedBackend: normalizeSyncBackend(requestedBackend),
    selectedBackend: selectedBackend || null,
    backendAttempts: Array.isArray(backendAttempts) ? backendAttempts : [],
    dryRun: Boolean(dryRun),
    recoveryOnly: Boolean(recoveryOnly),
    error: error ? (error.message || String(error)) : null,
    recovery: recovery || null,
    schedules: Array.isArray(schedules) ? schedules : [],
    operations: Array.isArray(operations) ? operations : [],
    lastSuccessfulState: cloneJsonValue(getLastSuccessfulSyncState(lastSuccessfulState)),
  };
}

function buildFailedSyncState({
  workspaceRoot,
  workflow,
  skillRoot,
  requestedBackend,
  selectedBackend,
  backendAttempts,
  error,
  openclawTimeoutMs,
  schedules = [],
  operations = [],
  lastSuccessfulState = null,
  status = 'failed',
}) {
  const lastSuccessfulSummary = summarizeSuccessfulSyncState(lastSuccessfulState);
  return buildPersistedSyncState({
    workflow,
    status,
    requestedBackend,
    selectedBackend,
    backendAttempts,
    dryRun: false,
    recoveryOnly: false,
    error,
    recovery: {
      mode: status === 'partial' ? 'partial-failure' : 'retry-guidance',
      summary: status === 'partial'
        ? 'Schedule sync applied some cron changes before failing.'
        : 'Schedule sync failed before it could reconcile cron state.',
      retryCommands: buildRecoveryCommands({
        workflow,
        skillRoot,
        workspaceRoot,
        openclawTimeoutMs,
      }),
      lastSyncState: lastSuccessfulSummary,
      caveats: status === 'partial'
        ? [
          'Some operations completed before the failure. Review live cron state before retrying.',
          'The lastSuccessfulState snapshot reflects the previous confirmed sync, not this partial attempt.',
        ]
        : [
          'No successful sync completion was recorded for this attempt.',
        ],
    },
    schedules,
    operations,
    lastSuccessfulState,
  });
}

function isRecoverableSyncFailure(error) {
  const details = String(error?.message || error || '').toLowerCase();
  if (!details) return false;

  return [
    'gateway connect failed',
    'gateway closed',
    'missing scope:',
    'operator-level status unavailable',
    'econnreset',
    'econnrefused',
    'etimedout',
    'socket hang up',
    'connection reset',
    'connection aborted',
    'unexpected eof',
    'failed to resolve openclaw.cmd',
    'not recognized as an internal or external command',
    'command not found',
    'enoent',
  ].some((pattern) => details.includes(pattern));
}

function buildRecoveryCommands({
  workflow,
  skillRoot,
  workspaceRoot,
  openclawTimeoutMs,
}) {
  const normalizedWorkspaceRoot = normalizePath(workspaceRoot);
  const syncScriptPath = normalizePath(path.join(skillRoot, 'scripts', 'sync-schedules.js'));
  const doctorScriptPath = normalizePath(path.join(skillRoot, 'scripts', 'doctor.js'));
  const sharedArgs = [
    '--workspace-root', normalizedWorkspaceRoot,
    '--workflow', workflow.workflowId,
    '--openclaw-timeout-ms', String(openclawTimeoutMs),
  ];

  return [
    {
      label: 'retry-auto',
      command: 'node',
      args: [syncScriptPath, ...sharedArgs, '--sync-backend', 'auto'],
    },
    {
      label: 'retry-gateway',
      command: 'node',
      args: [syncScriptPath, ...sharedArgs, '--sync-backend', 'gateway'],
    },
    {
      label: 'dry-run-gateway',
      command: 'node',
      args: [syncScriptPath, ...sharedArgs, '--sync-backend', 'gateway', '--dry-run'],
    },
    {
      label: 'doctor',
      command: 'node',
      args: [doctorScriptPath, ...sharedArgs],
    },
  ];
}

function buildSnapshotJobsFromSyncState(workflow, syncState) {
  const successfulState = getLastSuccessfulSyncState(syncState);
  return (Array.isArray(successfulState?.schedules) ? successfulState.schedules : [])
    .map((entry) => ({
      id: entry?.jobId || null,
      jobId: entry?.jobId || null,
      name: entry?.jobName || getManagedJobName(workflow.workflowId, entry?.scheduleId),
      enabled: entry?.enabled !== false,
    }))
    .filter((job) => Boolean(job.name));
}

function buildRecoveryState({
  workspaceRoot,
  workflow,
  skillRoot,
  requestedBackend,
  backendAttempts,
  error,
  openclawCommand,
  openclawTimeoutMs,
}) {
  const lastSyncState = readSyncState(workspaceRoot, workflow.workflowId);
  const lastSuccessfulState = getLastSuccessfulSyncState(lastSyncState);
  const recoveryCommands = buildRecoveryCommands({
    workflow,
    skillRoot,
    workspaceRoot,
    openclawTimeoutMs,
  });
  const state = buildPersistedSyncState({
    workflow,
    status: 'recovery-only',
    requestedBackend,
    selectedBackend: null,
    backendAttempts,
    dryRun: true,
    recoveryOnly: true,
    error,
    schedules: [],
    operations: [],
    lastSuccessfulState,
    recovery: {
      mode: 'retry-guidance',
      summary: 'Live OpenClaw cron state could not be reached. No cron changes were applied.',
      retryCommands: recoveryCommands,
      lastSyncState: null,
      caveats: [
        'Review gateway health and auth before retrying schedule sync.',
        'No cron mutation happened in this recovery-only result.',
      ],
    },
  });

  if (!lastSuccessfulState) {
    state.recovery.caveats.push('No previous sync snapshot was available, so no remediation plan could be derived.');
    return state;
  }

  const snapshotJobs = buildSnapshotJobsFromSyncState(workflow, lastSyncState);
  const plan = buildWorkflowSyncPlan({
    workspaceRoot,
    workflow,
    skillRoot,
    jobs: snapshotJobs,
    openclawCommand,
    openclawTimeoutMs,
  });

  state.schedules = plan.syncedSchedules;
  state.operations = plan.operations;
  state.recovery = {
    mode: 'sync-state-dry-run',
    summary: 'Live OpenClaw cron state could not be reached. Returned a best-effort dry-run plan derived from the last successful sync snapshot.',
    retryCommands: recoveryCommands,
    lastSyncState: summarizeSuccessfulSyncState(lastSuccessfulState),
    caveats: [
      'Review the remediation commands before applying them because the plan is based on the last sync snapshot, not live cron state.',
      'No cron mutation happened in this recovery-only result.',
    ],
  };
  return state;
}

function recoverSyncFailure({
  workspaceRoot,
  workflow,
  skillRoot,
  requestedBackend,
  backendAttempts,
  error,
  openclawCommand,
  openclawTimeoutMs,
  persistState = true,
}) {
  if (error?.syncState) return null;
  if (!isRecoverableSyncFailure(error)) return null;
  const state = buildRecoveryState({
    workspaceRoot,
    workflow,
    skillRoot,
    requestedBackend,
    backendAttempts,
    error,
    openclawCommand,
    openclawTimeoutMs,
  });
  if (persistState) {
    writeSyncState({
      workspaceRoot,
      workflowId: workflow.workflowId,
      state,
    });
  }
  return state;
}

function buildOperationFailurePrefix({ workflow, operation, backend }) {
  if (operation.type === 'add') {
    return `Failed to add cron job for ${workflow.workflowId}/${operation.scheduleId} via ${backend} backend`;
  }
  if (operation.type === 'edit') {
    return `Failed to edit cron job for ${workflow.workflowId}/${operation.scheduleId} via ${backend} backend`;
  }
  if (operation.type === 'disable-duplicate') {
    return `Failed to disable duplicate cron job ${operation.jobId || 'unknown-job'} for ${workflow.workflowId}/${operation.scheduleId} via ${backend} backend`;
  }
  if (operation.type === 'disable') {
    return `Failed to disable obsolete cron job ${operation.jobId || 'unknown-job'} for ${workflow.workflowId}/${operation.scheduleId} via ${backend} backend`;
  }
  return `Failed to apply ${operation.type} for ${workflow.workflowId}/${operation.scheduleId} via ${backend} backend`;
}

function executeOperationViaCli({
  workspaceRoot,
  workflow,
  operation,
  openclawCommand,
  openclawTimeoutMs,
  runCommandFn,
  openclawRetryCount,
  openclawRetryDelayMs,
  sleepFn,
}) {
  const result = runOpenclawCommand({
    openclawCommand,
    args: operation.cliArgs,
    workspaceRoot,
    openclawTimeoutMs,
    runCommandFn,
    openclawRetryCount,
    openclawRetryDelayMs,
    sleepFn,
  });
  if (!result.ok) {
    throw new Error(buildOpenclawFailureMessage({
      prefix: buildOperationFailurePrefix({ workflow, operation, backend: 'cli' }),
      result,
      workspaceRoot,
      openclawCommand,
      openclawTimeoutMs,
      runCommandFn,
    }));
  }

  return {
    jobId: operation.type === 'add' ? parseCronAddJson(result.stdout) : operation.jobId,
  };
}

function executeOperationViaGateway({
  workspaceRoot,
  workflow,
  operation,
  openclawCommand,
  openclawTimeoutMs,
  runCommandFn,
  openclawRetryCount,
  openclawRetryDelayMs,
  sleepFn,
}) {
  const result = runGatewayMethod({
    method: operation.gatewayMethod,
    params: operation.gatewayParams,
    openclawCommand,
    workspaceRoot,
    openclawTimeoutMs,
    runCommandFn,
    openclawRetryCount,
    openclawRetryDelayMs,
    sleepFn,
  });
  if (!result.ok) {
    throw new Error(buildOpenclawFailureMessage({
      prefix: buildOperationFailurePrefix({ workflow, operation, backend: 'gateway' }),
      result,
      workspaceRoot,
      openclawCommand,
      openclawTimeoutMs,
      runCommandFn,
    }));
  }

  const parsed = result.stdout && result.stdout.trim() ? parseOpenclawJson(result.stdout) : null;
  return {
    jobId: operation.type === 'add' ? extractCronJobId(parsed) : operation.jobId,
  };
}

function executePlannedOperation({
  workspaceRoot,
  workflow,
  operation,
  selectedBackend,
  openclawCommand,
  openclawTimeoutMs,
  runCommandFn,
  openclawRetryCount,
  openclawRetryDelayMs,
  sleepFn,
}) {
  if (selectedBackend === 'gateway') {
    return executeOperationViaGateway({
      workspaceRoot,
      workflow,
      operation,
      openclawCommand,
      openclawTimeoutMs,
      runCommandFn,
      openclawRetryCount,
      openclawRetryDelayMs,
      sleepFn,
    });
  }

  return executeOperationViaCli({
    workspaceRoot,
    workflow,
    operation,
    openclawCommand,
    openclawTimeoutMs,
    runCommandFn,
    openclawRetryCount,
    openclawRetryDelayMs,
    sleepFn,
  });
}

function syncWorkflowSchedulesWithBackend({
  workspaceRoot,
  workflow,
  skillRoot,
  requestedBackend,
  selectedBackend,
  dryRun = false,
  openclawCommand = 'openclaw',
  openclawTimeoutMs = 30000,
  openclawRetryCount = DEFAULT_OPENCLAW_RETRY_COUNT,
  openclawRetryDelayMs = DEFAULT_OPENCLAW_RETRY_DELAY_MS,
  runCommandFn = runCommand,
  sleepFn = sleepSync,
}) {
  const normalizedBackend = normalizeSyncBackend(selectedBackend);
  const previousSyncState = readSyncState(workspaceRoot, workflow.workflowId);
  const listResult = listCronJobsResolved({
    workspaceRoot,
    openclawCommand,
    openclawTimeoutMs,
    syncBackend: normalizedBackend,
    openclawRetryCount,
    openclawRetryDelayMs,
    includeDisabled: true,
    runCommandFn,
    sleepFn,
  });
  const plan = buildWorkflowSyncPlan({
    workspaceRoot,
    workflow,
    skillRoot,
    jobs: listResult.jobs,
    openclawCommand,
    openclawTimeoutMs,
  });

  if (!dryRun) {
    for (const operation of plan.operations) {
      try {
        const execution = executePlannedOperation({
          workspaceRoot,
          workflow,
          operation,
          selectedBackend: normalizedBackend,
          openclawCommand,
          openclawTimeoutMs,
          runCommandFn,
          openclawRetryCount,
          openclawRetryDelayMs,
          sleepFn,
        });
        operation.applied = true;
        if (operation.type === 'add' && execution.jobId) {
          operation.jobId = execution.jobId;
          const syncedSchedule = plan.syncedSchedules.find((entry) => entry.scheduleId === operation.scheduleId);
          if (syncedSchedule) syncedSchedule.jobId = execution.jobId;
        }
      } catch (error) {
        const appliedOperationCount = plan.operations.filter((entry) => entry.applied === true).length;
        const failedState = buildFailedSyncState({
          workspaceRoot,
          workflow,
          skillRoot,
          requestedBackend,
          selectedBackend: listResult.selectedBackend || normalizedBackend,
          backendAttempts: listResult.backendAttempts || [{ backend: normalizedBackend, ok: true }],
          error,
          openclawTimeoutMs,
          schedules: plan.syncedSchedules,
          operations: plan.operations,
          lastSuccessfulState: previousSyncState,
          status: appliedOperationCount > 0 ? 'partial' : 'failed',
        });
        writeSyncState({
          workspaceRoot,
          workflowId: workflow.workflowId,
          state: failedState,
        });
        error.syncState = failedState;
        throw error;
      }
    }
  }

  const state = buildPersistedSyncState({
    workflow,
    status: dryRun ? 'dry-run' : 'synced',
    requestedBackend,
    selectedBackend: listResult.selectedBackend || normalizedBackend,
    backendAttempts: listResult.backendAttempts || [{ backend: normalizedBackend, ok: true }],
    dryRun,
    recoveryOnly: false,
    error: null,
    recovery: null,
    schedules: plan.syncedSchedules,
    operations: plan.operations,
    lastSuccessfulState: null,
  });

  if (!dryRun) {
    writeSyncState({
      workspaceRoot,
      workflowId: workflow.workflowId,
      state,
    });
  }

  return state;
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
  syncBackend = DEFAULT_SYNC_BACKEND,
  dryRun = false,
  openclawCommand = 'openclaw',
  openclawTimeoutMs = 30000,
  openclawRetryCount = DEFAULT_OPENCLAW_RETRY_COUNT,
  openclawRetryDelayMs = DEFAULT_OPENCLAW_RETRY_DELAY_MS,
  runCommandFn = runCommand,
  sleepFn = sleepSync,
}) {
  const normalizedBackend = normalizeSyncBackend(syncBackend);
  if (normalizedBackend !== 'auto') {
    try {
      return syncWorkflowSchedulesWithBackend({
        workspaceRoot,
        workflow,
        skillRoot,
        requestedBackend: normalizedBackend,
        selectedBackend: normalizedBackend,
        dryRun,
        openclawCommand,
        openclawTimeoutMs,
        openclawRetryCount,
        openclawRetryDelayMs,
        runCommandFn,
        sleepFn,
      });
    } catch (backendError) {
      const recovered = recoverSyncFailure({
        workspaceRoot,
        workflow,
        skillRoot,
        requestedBackend: normalizedBackend,
        backendAttempts: [{
          backend: normalizedBackend,
          ok: false,
          error: backendError.message || String(backendError),
        }],
        error: backendError,
        openclawCommand,
        openclawTimeoutMs,
        persistState: !dryRun,
      });
      if (recovered) return recovered;
      if (backendError?.syncState) throw backendError;
      if (!dryRun) {
        writeSyncState({
          workspaceRoot,
          workflowId: workflow.workflowId,
          state: buildFailedSyncState({
            workspaceRoot,
            workflow,
            skillRoot,
            requestedBackend: normalizedBackend,
            selectedBackend: normalizedBackend,
            backendAttempts: [{
              backend: normalizedBackend,
              ok: false,
              error: backendError.message || String(backendError),
            }],
            error: backendError,
            openclawTimeoutMs,
            schedules: [],
            operations: backendError?.syncState?.operations || [],
            lastSuccessfulState: readSyncState(workspaceRoot, workflow.workflowId),
            status: backendError?.syncState?.status === 'partial' ? 'partial' : 'failed',
          }),
        });
      }
      throw backendError;
    }
  }

  try {
    return syncWorkflowSchedulesWithBackend({
      workspaceRoot,
      workflow,
      skillRoot,
      requestedBackend: 'auto',
      selectedBackend: 'cli',
      dryRun,
      openclawCommand,
      openclawTimeoutMs,
      openclawRetryCount,
      openclawRetryDelayMs,
      runCommandFn,
      sleepFn,
    });
  } catch (cliError) {
    const attempts = [{
      backend: 'cli',
      ok: false,
      error: cliError.message || String(cliError),
    }];
    try {
      const gatewayState = syncWorkflowSchedulesWithBackend({
        workspaceRoot,
        workflow,
        skillRoot,
        requestedBackend: 'auto',
        selectedBackend: 'gateway',
        dryRun,
        openclawCommand,
        openclawTimeoutMs,
        openclawRetryCount,
        openclawRetryDelayMs,
        runCommandFn,
        sleepFn,
      });
      return {
        ...gatewayState,
        backendAttempts: [...attempts, ...(gatewayState.backendAttempts || [{ backend: 'gateway', ok: true }])],
      };
    } catch (gatewayError) {
      const gatewayMessage = gatewayError.message || String(gatewayError);
      const combined = new Error(`Failed to sync workflow schedules via auto backend for ${workflow.workflowId}. CLI error: ${cliError.message || String(cliError)}. Gateway error: ${gatewayMessage}`);
      combined.backendAttempts = [
        ...attempts,
        {
          backend: 'gateway',
          ok: false,
          error: gatewayMessage,
        },
      ];
      const recovered = recoverSyncFailure({
        workspaceRoot,
        workflow,
        skillRoot,
        requestedBackend: 'auto',
        backendAttempts: combined.backendAttempts,
        error: combined,
        openclawCommand,
        openclawTimeoutMs,
        persistState: !dryRun,
      });
      if (recovered) return recovered;
      if (combined?.syncState) throw combined;
      if (!dryRun) {
        writeSyncState({
          workspaceRoot,
          workflowId: workflow.workflowId,
          state: buildFailedSyncState({
            workspaceRoot,
            workflow,
            skillRoot,
            requestedBackend: 'auto',
            selectedBackend: null,
            backendAttempts: combined.backendAttempts,
            error: combined,
            openclawTimeoutMs,
            schedules: [],
            operations: combined?.syncState?.operations || [],
            lastSuccessfulState: readSyncState(workspaceRoot, workflow.workflowId),
            status: combined?.syncState?.status === 'partial' ? 'partial' : 'failed',
          }),
        });
      }
      throw combined;
    }
  }
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
