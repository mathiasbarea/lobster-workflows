#!/usr/bin/env node
const path = require('path');

const { ensureArg, normalizePath, parseArgs, printJson } = require('./_lib');
const { createExecutionId, writeLatestResult, writeRunRecord } = require('./lib/execution-store');
const { runCommand } = require('./lib/process-utils');
const { extractWorkflowResult, isSuccessfulEnvelope } = require('./lib/result-extractor');
const { resolveScheduledOccurrence } = require('./lib/schedule-engine');
const { loadWorkflow } = require('./lib/workflow-loader');

function trimText(text, maxLength = 4000) {
  const value = String(text || '');
  if (value.length <= maxLength) return value;
  return value.slice(value.length - maxLength);
}

function buildRuntimeInvocation({ workflow, input }) {
  const runtime = workflow.config.runtime;
  const mergedInput = {
    ...(runtime.defaultInputs || {}),
    ...(input || {}),
  };
  const cwd = path.resolve(workflow.workflowRoot, runtime.workingDirectory || '.');

  if (runtime.runnerType === 'node') {
    const args = [workflow.entrypointPath];
    if (runtime.defaultAction) {
      args.push('--action', runtime.defaultAction);
    }
    return {
      command: process.execPath,
      args,
      cwd,
      stdinText: JSON.stringify(mergedInput),
    };
  }

  if (runtime.runnerType === 'lobster') {
    return {
      command: 'lobster',
      args: [
        'run',
        '--mode',
        'tool',
        '--file',
        workflow.entrypointPath,
        '--args-json',
        JSON.stringify(mergedInput),
      ],
      cwd,
      stdinText: '',
    };
  }

  throw new Error(`Unsupported runnerType: ${runtime.runnerType}`);
}

function parseJsonOutput(stdout) {
  if (!stdout || !stdout.trim()) return null;
  return JSON.parse(stdout);
}

async function runManagedWorkflow({
  workspaceRoot,
  workflowId,
  trigger = 'manual',
  scheduleId = null,
  input = {},
  startedAt = new Date().toISOString(),
  env = process.env,
}) {
  const workflow = loadWorkflow(workspaceRoot, workflowId);
  const executionId = createExecutionId({ workflowId, startedAt });
  const invocation = buildRuntimeInvocation({ workflow, input });
  const schedule = scheduleId ? (workflow.config.schedules || []).find((candidate) => candidate.scheduleId === scheduleId) : null;
  const scheduledOccurrence = trigger === 'scheduled' && schedule
    ? resolveScheduledOccurrence({
      workflowId,
      schedule,
      startedAt,
    })
    : null;

  const initialRecord = {
    executionId,
    workflowId,
    workflowRoot: normalizePath(workflow.workflowRoot),
    runnerType: workflow.config.runtime.runnerType,
    trigger,
    scheduleId,
    scheduledFor: scheduledOccurrence ? scheduledOccurrence.dueAt : null,
    startedAt,
    finishedAt: null,
    status: 'running',
    result: null,
    error: null,
    process: null,
    envelope: null,
  };
  writeRunRecord({ workspaceRoot, record: initialRecord });

  const processResult = runCommand(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    stdinText: invocation.stdinText,
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
    const successful = isSuccessfulEnvelope({
      config: workflow.config,
      envelope,
      processResult,
    });

    if (successful) {
      status = 'success';
      result = extractWorkflowResult({
        config: workflow.config,
        envelope,
      });
    } else {
      error = {
        code: envelope && envelope.error && envelope.error.code ? envelope.error.code : 'workflow_failed',
        message: envelope && envelope.error && envelope.error.message
          ? envelope.error.message
          : processResult.stderr || processResult.errorMessage || 'Workflow execution failed',
      };
    }
  }

  const finishedAt = new Date(Date.parse(startedAt) + processResult.durationMs).toISOString();
  const record = {
    ...initialRecord,
    finishedAt,
    status,
    result,
    error,
    process: {
      command: invocation.command,
      args: invocation.args,
      cwd: normalizePath(invocation.cwd),
      exitCode: processResult.exitCode,
      signal: processResult.signal,
      durationMs: processResult.durationMs,
      timedOut: processResult.timedOut,
      stdoutTail: trimText(processResult.stdout),
      stderrTail: trimText(processResult.stderr),
    },
    envelope,
  };

  const runPath = writeRunRecord({ workspaceRoot, record });
  let latestResultPath = null;
  if (status === 'success' && workflow.config.result?.latestResultPolicy !== 'never') {
    latestResultPath = writeLatestResult({
      workspaceRoot,
      workflowId,
      payload: {
        workflowId,
        executionId,
        updatedAt: finishedAt,
        status,
        trigger,
        scheduledFor: record.scheduledFor,
        result,
      },
    });
  }

  return {
    executionId,
    workflowId,
    status,
    runPath: normalizePath(runPath),
    latestResultPath: latestResultPath ? normalizePath(latestResultPath) : null,
    scheduledFor: record.scheduledFor,
    result,
    error,
  };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
    });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', reject);
  });
}

async function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const workspaceRoot = path.resolve(flags.workspaceRoot || process.cwd());
  const workflowId = ensureArg(flags, 'workflow');
  const stdinText = await readStdin();
  const input = stdinText && stdinText.trim() ? JSON.parse(stdinText) : {};
  const result = await runManagedWorkflow({
    workspaceRoot,
    workflowId,
    trigger: flags.trigger || 'manual',
    scheduleId: flags.scheduleId || null,
    input,
  });
  printJson(result);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  runManagedWorkflow,
};
