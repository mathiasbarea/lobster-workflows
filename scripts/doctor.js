#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseArgs } = require('./_lib');
const {
  getTelegramBotToken,
  resolveTelegramApprovers,
} = require('./lib/approval-utils');
const {
  inspectWorkflowScheduleSync,
  listCronJobs,
} = require('./lib/cron-sync');
const {
  collectGatewayAccessDiagnostics,
  describeCommandFailure,
  parseJsonCommandOutput,
  resolveGatewayListeningAddress,
} = require('./lib/openclaw-health');
const { runCommand } = require('./lib/process-utils');
const { syncSchedules } = require('./sync-schedules');
const { listWorkflowIds, loadWorkflow } = require('./lib/workflow-loader');
const {
  DEFAULT_AGENT_ID,
  LLM_TASK_PLUGIN_ID,
  parseAgentsListJson,
} = require('./enable-llm-task');
const {
  PLUGIN_ID,
  isMissingConfigPath,
  parsePluginsAllowJson,
} = require('./install-telegram-plugin');

const STOCK_TELEGRAM_PLUGIN_ID = 'telegram';
const LLM_TASK_SCAN_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.lobster']);
const LLM_TASK_SCAN_IGNORED_DIRECTORIES = new Set(['node_modules', 'tests', 'old', '_executions']);

function createCheck(id, status, summary, hint = null) {
  return { id, status, summary, hint };
}

function getOverallStatus(checks) {
  if (checks.some((check) => check.status === 'fail')) return 'fail';
  if (checks.some((check) => check.status === 'warn')) return 'warn';
  return 'ok';
}

function normalizeComparablePath(filePath) {
  if (!filePath) return null;
  const normalized = path.resolve(String(filePath))
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function resolveOpenClawHome(env = process.env) {
  const explicitHome = String(env.OPENCLAW_HOME || env.CODEX_HOME || '').trim();
  if (explicitHome) return explicitHome;

  const userHome = env.HOME || env.USERPROFILE || os.homedir();
  if (!userHome) return null;
  return path.join(userHome, '.openclaw');
}

function readOpenClawConfigFallback(env = process.env) {
  try {
    const openClawHome = resolveOpenClawHome(env);
    if (!openClawHome) return null;
    const configPath = path.join(openClawHome, 'openclaw.json');
    if (!fs.existsSync(configPath)) return null;
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveWorkspaceRoot({ requestedWorkspaceRoot = null, pluginInfo = null, env = process.env }) {
  const explicit = String(requestedWorkspaceRoot || '').trim();
  if (explicit) return path.resolve(explicit);

  const pluginWorkspace = String(pluginInfo?.workspaceDir || '').trim();
  if (pluginWorkspace) return path.resolve(pluginWorkspace);

  const config = readOpenClawConfigFallback(env) || {};
  const configuredWorkspace = String(config?.agents?.defaults?.workspace || '').trim();
  if (configuredWorkspace) return path.resolve(configuredWorkspace);

  const openClawHome = resolveOpenClawHome(env);
  if (!openClawHome) return null;
  return path.join(openClawHome, 'workspace');
}

function loadPluginInfo(pluginId, { cwd, env, run = runCommand }) {
  const result = run(env.LOBSTER_WORKFLOWS_OPENCLAW_BIN || 'openclaw', ['plugins', 'info', pluginId, '--json'], {
    cwd,
    env,
    timeoutMs: 30000,
  });
  return parseJsonCommandOutput(`openclaw plugins info ${pluginId}`, result);
}

function loadPluginsAllow({ cwd, env, run = runCommand }) {
  return loadStringArrayConfig('plugins.allow', { cwd, env, run });
}

function parseStringArrayJson(rawValue, configPath) {
  const text = String(rawValue || '').trim();
  if (!text) return [];

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse ${configPath} as JSON: ${error.message}`);
  }

  if (parsed == null) return [];
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected ${configPath} to be a JSON array.`);
  }

  return parsed
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function loadStringArrayConfig(configPath, { cwd, env, run = runCommand }) {
  const result = run(env.LOBSTER_WORKFLOWS_OPENCLAW_BIN || 'openclaw', ['config', 'get', configPath, '--json'], {
    cwd,
    env,
    timeoutMs: 30000,
  });

  if (result.ok) {
    return {
      present: true,
      values: configPath === 'plugins.allow'
        ? parsePluginsAllowJson(result.stdout)
        : parseStringArrayJson(result.stdout, configPath),
    };
  }

  if (isMissingConfigPath(result)) {
    return {
      present: false,
      values: [],
    };
  }

  throw new Error(describeCommandFailure(`Reading ${configPath}`, result));
}

function loadAgentsList({ cwd, env, run = runCommand }) {
  const result = run(env.LOBSTER_WORKFLOWS_OPENCLAW_BIN || 'openclaw', ['config', 'get', 'agents.list', '--json'], {
    cwd,
    env,
    timeoutMs: 30000,
  });

  if (result.ok) {
    return {
      present: true,
      values: parseAgentsListJson(result.stdout),
    };
  }

  if (isMissingConfigPath(result)) {
    return {
      present: false,
      values: [],
    };
  }

  throw new Error(describeCommandFailure('Reading agents.list', result));
}

function pathContainsLlmTaskReference(targetPath) {
  try {
    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(targetPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && LLM_TASK_SCAN_IGNORED_DIRECTORIES.has(entry.name)) continue;
        if (pathContainsLlmTaskReference(path.join(targetPath, entry.name))) return true;
      }
      return false;
    }

    const extension = path.extname(targetPath).toLowerCase();
    if (!LLM_TASK_SCAN_EXTENSIONS.has(extension)) return false;
    const content = fs.readFileSync(targetPath, 'utf8');
    return content.includes(LLM_TASK_PLUGIN_ID);
  } catch {
    return false;
  }
}

function inspectLlmTaskUsage({
  workspaceRoot,
  workflowId = null,
  listWorkflowIdsFn = listWorkflowIds,
  loadWorkflowFn = loadWorkflow,
}) {
  if (!workspaceRoot) {
    return {
      skipped: true,
      workflowIds: [],
      required: false,
      skipReason: 'Workspace root could not be resolved.',
    };
  }

  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  if (!fs.existsSync(resolvedWorkspaceRoot)) {
    return {
      skipped: true,
      workflowIds: [],
      required: false,
      skipReason: `Workspace root does not exist: ${resolvedWorkspaceRoot}`,
    };
  }

  const targetWorkflowIds = workflowId ? [workflowId] : listWorkflowIdsFn(resolvedWorkspaceRoot);
  const requiredWorkflowIds = targetWorkflowIds.filter((currentWorkflowId) => {
    const workflow = loadWorkflowFn(resolvedWorkspaceRoot, currentWorkflowId);
    return pathContainsLlmTaskReference(workflow.workflowRoot);
  });

  return {
    skipped: false,
    workflowIds: requiredWorkflowIds,
    required: requiredWorkflowIds.length > 0,
  };
}

function allowlistIncludesTool(values, toolName) {
  const normalizedValues = (Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);
  const normalizedTool = String(toolName || '').trim().toLowerCase();
  return normalizedValues.includes('*') ||
    normalizedValues.includes('group:plugins') ||
    normalizedValues.includes(normalizedTool);
}

function agentAllowsTool(agentsList, agentId, toolName) {
  const normalizedAgentId = String(agentId || DEFAULT_AGENT_ID).trim();
  const agent = (Array.isArray(agentsList) ? agentsList : [])
    .find((entry) => String(entry?.id || '').trim() === normalizedAgentId);
  if (!agent || !agent.tools || typeof agent.tools !== 'object') return false;
  return allowlistIncludesTool(agent.tools.allow, toolName) ||
    allowlistIncludesTool(agent.tools.alsoAllow, toolName);
}

function validateOpenClawConfig({ cwd, env, run = runCommand }) {
  const result = run(env.LOBSTER_WORKFLOWS_OPENCLAW_BIN || 'openclaw', ['config', 'validate'], {
    cwd,
    env,
    timeoutMs: 30000,
  });

  return {
    ok: result.ok,
    error: result.ok ? null : describeCommandFailure('openclaw config validate', result),
  };
}

function formatScheduleDriftEntry(entry) {
  if (!entry || typeof entry !== 'object') return 'Unknown schedule drift';
  const scheduleId = entry.scheduleId ? String(entry.scheduleId) : 'unknown-schedule';
  if (entry.type === 'missing-active-job') {
    return `${scheduleId}: missing managed cron job`;
  }
  if (entry.type === 'disabled-active-job') {
    return `${scheduleId}: managed cron job exists but is disabled`;
  }
  if (entry.type === 'duplicate-enabled-jobs') {
    const jobIds = Array.isArray(entry.jobIds) && entry.jobIds.length > 0 ? ` (${entry.jobIds.join(', ')})` : '';
    return `${scheduleId}: multiple enabled managed cron jobs${jobIds}`;
  }
  if (entry.type === 'unexpected-enabled-job') {
    const jobId = entry.jobId ? ` (${entry.jobId})` : '';
    return `${scheduleId}: enabled managed cron job exists without an active schedule${jobId}`;
  }
  if (entry.type === 'mismatched-job') {
    const fields = Array.isArray(entry.fields) && entry.fields.length > 0 ? ` [${entry.fields.join(', ')}]` : '';
    return `${scheduleId}: managed cron job differs from workflow config${fields}`;
  }
  return `${scheduleId}: ${entry.type}`;
}

function summarizeScheduleDrift(drifts, maxEntries = 4) {
  const entries = (Array.isArray(drifts) ? drifts : [])
    .slice(0, maxEntries)
    .map(formatScheduleDriftEntry);
  if (entries.length === 0) return '';
  const suffix = drifts.length > maxEntries ? `; +${drifts.length - maxEntries} more` : '';
  return `${entries.join('; ')}${suffix}`;
}

function buildGatewayRpcCheck(gatewayAccess) {
  if (!gatewayAccess) return null;

  if (gatewayAccess.gatewayStatusError) {
    return createCheck(
      'gateway-rpc',
      'warn',
      `Could not inspect Gateway RPC health. ${gatewayAccess.gatewayStatusError}`,
      'Run `openclaw gateway status --json` to inspect transport-level gateway health.',
    );
  }

  const gatewayStatus = gatewayAccess.gatewayStatus;
  if (!gatewayStatus) return null;

  const address = resolveGatewayListeningAddress(gatewayStatus);
  const rpcUrl = gatewayStatus?.rpc?.url || gatewayStatus?.gateway?.probeUrl || 'unknown url';
  if (gatewayStatus?.rpc?.ok === true) {
    const suffix = address ? ` and is listening on ${address}` : '';
    return createCheck('gateway-rpc', 'ok', `Gateway RPC probe succeeded at ${rpcUrl}${suffix}.`);
  }

  return createCheck(
    'gateway-rpc',
    'fail',
    `Gateway transport is not responding at ${rpcUrl}.`,
    'Run `openclaw gateway status` and inspect the gateway service/logs before retrying schedule sync.',
  );
}

function buildGatewayOperatorAccessCheck(gatewayAccess) {
  if (!gatewayAccess) return null;

  if (gatewayAccess.openclawStatusError) {
    return createCheck(
      'gateway-operator-access',
      'warn',
      `Could not inspect operator-level gateway access. ${gatewayAccess.openclawStatusError}`,
      'Run `openclaw status --json` to inspect operator-level gateway access from this CLI context.',
    );
  }

  const gateway = gatewayAccess.openclawStatus?.gateway;
  if (!gateway) return null;
  if (gateway.reachable === true) {
    return createCheck('gateway-operator-access', 'ok', 'Operator-level gateway status is readable from this CLI context.');
  }

  const error = gateway.error || 'unknown error';
  if (/missing scope:\s*operator\.read/i.test(String(error))) {
    return createCheck(
      'gateway-operator-access',
      'warn',
      `Gateway is up, but operator-level status is not readable from this CLI context (${error}).`,
      'This limits diagnostics and makes `openclaw status` look unreachable, but it does not automatically mean cron management is down.',
    );
  }

  return createCheck(
    'gateway-operator-access',
    'warn',
    `Operator-level gateway access is degraded (${error}).`,
    'Check gateway auth or scope configuration if managed cron operations also fail.',
  );
}

function inspectScheduleSync({
  skillRoot,
  workspaceRoot,
  workflowId = null,
  env = process.env,
  run = runCommand,
  openclawCommand = env.LOBSTER_WORKFLOWS_OPENCLAW_BIN || 'openclaw',
  openclawTimeoutMs = 30000,
  listWorkflowIdsFn = listWorkflowIds,
  loadWorkflowFn = loadWorkflow,
  listCronJobsFn = listCronJobs,
}) {
  if (!workspaceRoot) {
    return {
      skipped: true,
      workspaceRoot: null,
      workflowCount: 0,
      inspections: [],
      driftedWorkflows: [],
      skipReason: 'Workspace root could not be resolved.',
    };
  }

  const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
  if (!fs.existsSync(resolvedWorkspaceRoot)) {
    return {
      skipped: true,
      workspaceRoot: resolvedWorkspaceRoot,
      workflowCount: 0,
      inspections: [],
      driftedWorkflows: [],
      skipReason: `Workspace root does not exist: ${resolvedWorkspaceRoot}`,
    };
  }

  const targetWorkflowIds = workflowId ? [workflowId] : listWorkflowIdsFn(resolvedWorkspaceRoot);
  if (targetWorkflowIds.length === 0) {
    return {
      skipped: false,
      workspaceRoot: resolvedWorkspaceRoot,
      workflowCount: 0,
      inspections: [],
      driftedWorkflows: [],
      inSync: true,
    };
  }

  const workflows = targetWorkflowIds.map((currentWorkflowId) => loadWorkflowFn(resolvedWorkspaceRoot, currentWorkflowId));
  const jobs = listCronJobsFn({
    workspaceRoot: resolvedWorkspaceRoot,
    openclawCommand,
    openclawTimeoutMs,
    includeDisabled: true,
    runCommandFn: run,
  });
  const inspections = workflows.map((workflow) => inspectWorkflowScheduleSync({
    workspaceRoot: resolvedWorkspaceRoot,
    workflow,
    skillRoot,
    jobs,
  }));
  const driftedWorkflows = inspections.filter((inspection) => !inspection.inSync);

  return {
    skipped: false,
    workspaceRoot: resolvedWorkspaceRoot,
    workflowCount: inspections.length,
    inspections,
    driftedWorkflows,
    inSync: driftedWorkflows.length === 0,
  };
}

function applyScheduleSyncFixes({
  skillRoot,
  workspaceRoot,
  workflowIds,
  env = process.env,
  run = runCommand,
  openclawCommand = env.LOBSTER_WORKFLOWS_OPENCLAW_BIN || 'openclaw',
  openclawTimeoutMs = 30000,
  syncSchedulesFn = syncSchedules,
}) {
  const applied = [];
  const errors = [];

  for (const workflowId of [...new Set((Array.isArray(workflowIds) ? workflowIds : []).filter(Boolean))]) {
    try {
      const result = syncSchedulesFn({
        workspaceRoot,
        workflowId,
        skillRoot,
        openclawCommand,
        openclawTimeoutMs,
        runCommandFn: run,
      });
      const workflowResult = result.workflows?.[0] || null;
      if (workflowResult?.recoveryOnly) {
        errors.push({
          workflowId,
          error: workflowResult.error || workflowResult.recovery?.summary || 'Schedule sync returned recovery-only guidance.',
        });
        continue;
      }
      applied.push({
        workflowId,
        operations: workflowResult?.operations || [],
      });
    } catch (error) {
      errors.push({
        workflowId,
        error: error.message || String(error),
      });
    }
  }

  return {
    applied,
    errors,
  };
}

function evaluateDoctorChecks({
  skillRoot,
  workspaceRoot = null,
  localPluginExists,
  pluginInfo,
  pluginInfoError = null,
  telegramPluginInfo,
  telegramPluginError = null,
  pluginsAllow,
  pluginsAllowError = null,
  telegramBotToken,
  globalApprovers,
  configValidation,
  gatewayAccess = null,
  scheduleSync = null,
  llmTask = null,
}) {
  const checks = [];
  const expectedPluginSource = path.join(skillRoot, 'plugin', 'index.js');

  checks.push(
    localPluginExists
      ? createCheck('local-plugin-bundle', 'ok', `Plugin bundle found at ${expectedPluginSource}.`)
      : createCheck('local-plugin-bundle', 'fail', `Plugin bundle is missing at ${expectedPluginSource}.`, 'Make sure the skill was installed with the plugin folder included.'),
  );

  if (pluginInfoError) {
    checks.push(createCheck(
      'lobster-plugin-install',
      'fail',
      `OpenClaw could not load ${PLUGIN_ID}. ${pluginInfoError}`,
      'Run `node scripts/install-telegram-plugin.js` from this skill folder.',
    ));
  } else {
    const pluginLoaded = pluginInfo?.enabled === true && pluginInfo?.status === 'loaded';
    const hasLwfCommand = Array.isArray(pluginInfo?.commands) && pluginInfo.commands.includes('lwf');
    checks.push(
      pluginLoaded && hasLwfCommand
        ? createCheck('lobster-plugin-install', 'ok', `${PLUGIN_ID} is installed, enabled, and exposes the /lwf command.`)
        : createCheck('lobster-plugin-install', 'fail', `${PLUGIN_ID} is not fully active in OpenClaw.`, 'Run `node scripts/install-telegram-plugin.js` and restart the gateway.'),
    );

    const actualSource = normalizeComparablePath(pluginInfo?.source);
    const expectedSource = normalizeComparablePath(expectedPluginSource);
    if (actualSource && expectedSource && actualSource === expectedSource) {
      checks.push(createCheck('lobster-plugin-source', 'ok', 'OpenClaw is loading the plugin from this skill folder.'));
    } else {
      checks.push(createCheck(
        'lobster-plugin-source',
        'warn',
        `OpenClaw is loading ${PLUGIN_ID} from ${pluginInfo?.source || 'an unknown path'}.`,
        `Reinstall the plugin from ${skillRoot} if you want this copy of the skill to be the active one.`,
      ));
    }
  }

  if (telegramPluginError) {
    checks.push(createCheck(
      'telegram-channel-plugin',
      'fail',
      `OpenClaw could not inspect the stock Telegram plugin. ${telegramPluginError}`,
      'Enable the bundled Telegram channel plugin before using Telegram approvals.',
    ));
  } else {
    const telegramLoaded = telegramPluginInfo?.enabled === true && telegramPluginInfo?.status === 'loaded';
    checks.push(
      telegramLoaded
        ? createCheck('telegram-channel-plugin', 'ok', 'The stock Telegram channel plugin is enabled.')
        : createCheck('telegram-channel-plugin', 'fail', 'The stock Telegram channel plugin is not enabled.', 'Enable the bundled Telegram plugin in OpenClaw before using Telegram approvals.'),
    );
  }

  if (!configValidation?.ok) {
    checks.push(createCheck(
      'openclaw-config',
      'fail',
      configValidation?.error || 'openclaw config validate reported an error.',
      'Fix the OpenClaw configuration before relying on the Telegram approval flow.',
    ));
  } else {
    checks.push(createCheck('openclaw-config', 'ok', 'OpenClaw configuration validates cleanly.'));
  }

  const gatewayRpcCheck = buildGatewayRpcCheck(gatewayAccess);
  if (gatewayRpcCheck) checks.push(gatewayRpcCheck);

  const gatewayOperatorAccessCheck = buildGatewayOperatorAccessCheck(gatewayAccess);
  if (gatewayOperatorAccessCheck) checks.push(gatewayOperatorAccessCheck);

  if (pluginsAllowError) {
    checks.push(createCheck(
      'plugins-allow',
      'fail',
      pluginsAllowError,
      'Fix the OpenClaw config access issue, then rerun the doctor.',
    ));
  } else {
    const allowValues = Array.isArray(pluginsAllow?.values) ? pluginsAllow.values : [];
    const allowIncludesPlugin = allowValues.includes(PLUGIN_ID);
    if (allowIncludesPlugin) {
      checks.push(createCheck('plugins-allow', 'ok', `${PLUGIN_ID} is explicitly trusted in plugins.allow.`));
    } else if (pluginsAllow?.present) {
      checks.push(createCheck(
        'plugins-allow',
        'warn',
        `${PLUGIN_ID} is not present in plugins.allow.`,
        'Run `node scripts/install-telegram-plugin.js` to merge it into the allowlist.',
      ));
    } else {
      checks.push(createCheck(
        'plugins-allow',
        'warn',
        'plugins.allow is not configured.',
        'Run `node scripts/install-telegram-plugin.js` to create plugins.allow with the plugin id merged in.',
      ));
    }
  }

  if (telegramBotToken) {
    checks.push(createCheck('telegram-bot-token', 'ok', 'Telegram bot token is configured.'));
  } else {
    checks.push(createCheck(
      'telegram-bot-token',
      'warn',
      'Telegram bot token was not found in the current environment or openclaw.json.',
      'Set channels.telegram.botToken in openclaw.json or provide TELEGRAM_BOT_TOKEN to the gateway.',
    ));
  }

  if (Array.isArray(globalApprovers) && globalApprovers.length > 0) {
    checks.push(createCheck('telegram-approvers', 'ok', `Global Telegram approvers configured: ${globalApprovers.join(', ')}.`));
  } else {
    checks.push(createCheck(
      'telegram-approvers',
      'warn',
      'No global Telegram approvers were found.',
      'This is fine if each workflow sets approvals.telegram.approvers. Otherwise configure a global fallback in openclaw.json or env.',
    ));
  }

  const llmTaskPluginLoaded = llmTask?.pluginInfo?.enabled === true && llmTask?.pluginInfo?.status === 'loaded';
  const llmTaskPluginExcludedByAllowlist = llmTask && pluginsAllow?.present && !pluginsAllow?.values?.includes(LLM_TASK_PLUGIN_ID);

  if (llmTask?.required || llmTask?.inspectError) {
    const workflowLabel = llmTask.workflowIds.length === 1
      ? `Workflow ${llmTask.workflowIds[0]}`
      : `Workflows ${llmTask.workflowIds.join(', ')}`;

    if (llmTask.inspectError) {
      checks.push(createCheck(
        'llm-task-usage',
        'fail',
        `Could not inspect llm-task usage. ${llmTask.inspectError}`,
        'Fix the workspace inspection issue, then rerun the doctor.',
      ));
    } else if (llmTask.pluginInfoError) {
      checks.push(createCheck(
        'llm-task-plugin',
        'fail',
        `${workflowLabel} require ${LLM_TASK_PLUGIN_ID}, but OpenClaw could not inspect that plugin. ${llmTask.pluginInfoError}`,
        'Run `node scripts/enable-llm-task.js` and restart the gateway.',
      ));
    } else {
      if (llmTaskPluginLoaded) {
        checks.push(createCheck('llm-task-plugin', 'ok', `${workflowLabel} require ${LLM_TASK_PLUGIN_ID}, and the plugin is active in OpenClaw.`));
      } else if (llmTaskPluginExcludedByAllowlist || /not in allowlist/i.test(String(llmTask.pluginInfo?.error || ''))) {
        checks.push(createCheck(
          'llm-task-plugin',
          'fail',
          `${workflowLabel} require ${LLM_TASK_PLUGIN_ID}, but the plugin is excluded from plugins.allow.`,
          'Run `node scripts/enable-llm-task.js` to merge it into plugins.allow, then restart the gateway.',
        ));
      } else {
        checks.push(createCheck(
          'llm-task-plugin',
          'fail',
          `${workflowLabel} require ${LLM_TASK_PLUGIN_ID}, but the plugin is not active in OpenClaw.`,
          'Run `node scripts/enable-llm-task.js` and restart the gateway.',
        ));
      }
    }

    if (llmTask.toolPolicyError) {
      checks.push(createCheck(
        'llm-task-tool-policy',
        'fail',
        `Could not inspect the ${LLM_TASK_PLUGIN_ID} tool policy. ${llmTask.toolPolicyError}`,
        'Fix the OpenClaw config access issue, then rerun the doctor.',
      ));
    } else if (llmTask.toolAllowed) {
      checks.push(createCheck(
        'llm-task-tool-policy',
        'ok',
        `${DEFAULT_AGENT_ID} can invoke ${LLM_TASK_PLUGIN_ID} through the current tool policy.`,
      ));
    } else {
      checks.push(createCheck(
        'llm-task-tool-policy',
        'fail',
        `${workflowLabel} require ${LLM_TASK_PLUGIN_ID}, but agent "${DEFAULT_AGENT_ID}" is not allowlisted to invoke it.`,
        'Run `node scripts/enable-llm-task.js` to merge llm-task into agents.list[].tools.allow.',
      ));
    }
  } else if (llmTask) {
    if (llmTask.pluginInfoError || llmTask.toolPolicyError) {
      const issues = [llmTask.pluginInfoError, llmTask.toolPolicyError]
        .filter(Boolean)
        .join(' ');
      checks.push(createCheck(
        'llm-task-readiness',
        'warn',
        `Optional ${LLM_TASK_PLUGIN_ID} readiness could not be fully inspected. ${issues}`,
        'If you plan to add workflows that use llm-task, run `node scripts/enable-llm-task.js` and rerun the doctor.',
      ));
    } else {
      const readinessIssues = [];
      if (!llmTaskPluginLoaded) {
        readinessIssues.push(
          llmTaskPluginExcludedByAllowlist || /not in allowlist/i.test(String(llmTask.pluginInfo?.error || ''))
            ? `${LLM_TASK_PLUGIN_ID} is excluded from plugins.allow`
            : `${LLM_TASK_PLUGIN_ID} is not active in OpenClaw`,
        );
      }
      if (!llmTask.toolAllowed) {
        readinessIssues.push(`agent "${DEFAULT_AGENT_ID}" is not allowlisted to invoke ${LLM_TASK_PLUGIN_ID}`);
      }

      if (readinessIssues.length === 0) {
        checks.push(createCheck(
          'llm-task-readiness',
          'ok',
          `Optional ${LLM_TASK_PLUGIN_ID} readiness is already in place for agent "${DEFAULT_AGENT_ID}".`,
        ));
      } else {
        checks.push(createCheck(
          'llm-task-readiness',
          'warn',
          `Optional ${LLM_TASK_PLUGIN_ID} readiness is incomplete: ${readinessIssues.join('; ')}.`,
          'If you plan to add workflows that use llm-task, run `node scripts/enable-llm-task.js` and restart the gateway.',
        ));
      }
    }
  }

  if (scheduleSync?.error) {
    const scheduleSyncHint = gatewayAccess?.gatewayStatus?.rpc?.ok === true
      ? 'Gateway transport is up, so verify cron-management access and auth/scopes from this CLI context before retrying.'
      : 'Make sure the OpenClaw gateway is reachable, then rerun the doctor.';
    checks.push(createCheck(
      'schedule-sync',
      'fail',
      scheduleSync.error,
      scheduleSyncHint,
    ));
  } else if (scheduleSync?.skipped) {
    checks.push(createCheck(
      'schedule-sync',
      'warn',
      scheduleSync.skipReason || 'Schedule drift check was skipped.',
      'Pass `--workspace-root` explicitly if the workspace is installed in a non-default location.',
    ));
  } else if (scheduleSync && scheduleSync.workflowCount === 0) {
    checks.push(createCheck('schedule-sync', 'ok', 'No workflows were found for schedule drift inspection.'));
  } else if (scheduleSync?.fixAttempt?.errors?.length > 0) {
    const errorSummary = scheduleSync.fixAttempt.errors
      .map((entry) => `${entry.workflowId}: ${entry.error}`)
      .join('; ');
    checks.push(createCheck(
      'schedule-sync',
      'fail',
      `Automatic schedule sync repair failed. ${errorSummary}`,
      'Fix the reported workflow sync errors, then rerun `node scripts/doctor.js --fix`.',
    ));
  } else if (scheduleSync?.fixRequested && scheduleSync?.driftedWorkflows?.length === 0) {
    const appliedCount = scheduleSync.fixAttempt?.applied?.length || 0;
    if (appliedCount > 0) {
      checks.push(createCheck('schedule-sync', 'ok', `Repaired OpenClaw cron drift for ${appliedCount} workflow(s).`));
    } else {
      checks.push(createCheck('schedule-sync', 'ok', 'OpenClaw cron is already in sync with workflow schedules.'));
    }
  } else if (scheduleSync?.driftedWorkflows?.length > 0) {
    const workflowSummary = scheduleSync.driftedWorkflows
      .map((inspection) => `${inspection.workflowId}: ${summarizeScheduleDrift(inspection.drift)}`)
      .join(' | ');
    checks.push(createCheck(
      'schedule-sync',
      'warn',
      `OpenClaw cron drift detected in ${scheduleSync.driftedWorkflows.length} workflow(s). ${workflowSummary}`,
      workspaceRoot
        ? `Run \`node scripts/doctor.js --workspace-root "${workspaceRoot}" --fix\` or \`node scripts/sync-schedules.js --workspace-root "${workspaceRoot}"\`.`
        : 'Run `node scripts/doctor.js --fix` or `node scripts/sync-schedules.js --workspace-root <path>`.',
    ));
  } else if (scheduleSync) {
    checks.push(createCheck('schedule-sync', 'ok', 'OpenClaw cron is in sync with workflow schedules.'));
  }

  return {
    status: getOverallStatus(checks),
    checks,
  };
}

function formatDoctorReport(report, { skillRoot }) {
  const lines = [
    `Lobster Workflows Doctor: ${report.status.toUpperCase()}`,
    `Skill root: ${skillRoot}`,
    ...(report.workspaceRoot ? [`Workspace root: ${report.workspaceRoot}`] : []),
    '',
  ];

  for (const check of report.checks) {
    const prefix = check.status === 'ok' ? 'OK' : (check.status === 'warn' ? 'WARN' : 'FAIL');
    lines.push(`[${prefix}] ${check.summary}`);
    if (check.hint) {
      lines.push(`      ${check.hint}`);
    }
  }

  return lines.join('\n');
}

function runDoctor({
  env = process.env,
  run = runCommand,
  skillRoot = path.resolve(__dirname, '..'),
  workspaceRoot = null,
  workflowId = null,
  fix = false,
  openclawCommand = env.LOBSTER_WORKFLOWS_OPENCLAW_BIN || 'openclaw',
  openclawTimeoutMs = 30000,
  inspectScheduleSyncFn = inspectScheduleSync,
  applyScheduleSyncFixesFn = applyScheduleSyncFixes,
  inspectLlmTaskUsageFn = inspectLlmTaskUsage,
} = {}) {
  const localPluginExists = fs.existsSync(path.join(skillRoot, 'plugin', 'index.js'));

  let pluginInfo = null;
  let pluginInfoError = null;
  try {
    pluginInfo = loadPluginInfo(PLUGIN_ID, { cwd: skillRoot, env, run });
  } catch (error) {
    pluginInfoError = error.message || String(error);
  }

  let telegramPluginInfo = null;
  let telegramPluginError = null;
  try {
    telegramPluginInfo = loadPluginInfo(STOCK_TELEGRAM_PLUGIN_ID, { cwd: skillRoot, env, run });
  } catch (error) {
    telegramPluginError = error.message || String(error);
  }

  let pluginsAllow = { present: false, values: [] };
  let pluginsAllowError = null;
  try {
    pluginsAllow = loadPluginsAllow({ cwd: skillRoot, env, run });
  } catch (error) {
    pluginsAllowError = error.message || String(error);
  }

  const configValidation = validateOpenClawConfig({ cwd: skillRoot, env, run });
  const gatewayAccess = collectGatewayAccessDiagnostics({
    cwd: skillRoot,
    env,
    run,
    openclawCommand,
    timeoutMs: Math.max(10000, Math.min(20000, openclawTimeoutMs)),
  });
  const resolvedWorkspaceRoot = resolveWorkspaceRoot({
    requestedWorkspaceRoot: workspaceRoot,
    pluginInfo,
    env,
  });
  let llmTask = null;
  try {
    const llmTaskUsage = inspectLlmTaskUsageFn({
      workspaceRoot: resolvedWorkspaceRoot,
      workflowId,
    });
    llmTask = {
      ...llmTaskUsage,
      pluginInfo: null,
      pluginInfoError: null,
      toolPolicyError: null,
      toolAllowed: false,
    };
    try {
      llmTask.pluginInfo = loadPluginInfo(LLM_TASK_PLUGIN_ID, { cwd: skillRoot, env, run });
    } catch (error) {
      llmTask.pluginInfoError = error.message || String(error);
    }

    try {
      const globalToolsAllow = loadStringArrayConfig('tools.allow', { cwd: skillRoot, env, run });
      const globalToolsAlsoAllow = loadStringArrayConfig('tools.alsoAllow', { cwd: skillRoot, env, run });
      const agentsList = loadAgentsList({ cwd: skillRoot, env, run });
      llmTask.toolAllowed = allowlistIncludesTool(globalToolsAllow.values, LLM_TASK_PLUGIN_ID) ||
        allowlistIncludesTool(globalToolsAlsoAllow.values, LLM_TASK_PLUGIN_ID) ||
        agentAllowsTool(agentsList.values, DEFAULT_AGENT_ID, LLM_TASK_PLUGIN_ID);
    } catch (error) {
      llmTask.toolPolicyError = error.message || String(error);
    }
  } catch (error) {
    llmTask = {
      skipped: false,
      required: false,
      workflowIds: [],
      inspectError: error.message || String(error),
      pluginInfo: null,
      pluginInfoError: null,
      toolPolicyError: null,
      toolAllowed: false,
    };
  }
  let scheduleSync = null;
  try {
    scheduleSync = inspectScheduleSyncFn({
      skillRoot,
      workspaceRoot: resolvedWorkspaceRoot,
      workflowId,
      env,
      run,
      openclawCommand,
      openclawTimeoutMs,
    });

    if (fix && !scheduleSync.skipped && !scheduleSync.error && Array.isArray(scheduleSync.driftedWorkflows) && scheduleSync.driftedWorkflows.length > 0) {
      const fixAttempt = applyScheduleSyncFixesFn({
        skillRoot,
        workspaceRoot: scheduleSync.workspaceRoot,
        workflowIds: scheduleSync.driftedWorkflows.map((inspection) => inspection.workflowId),
        env,
        run,
        openclawCommand,
        openclawTimeoutMs,
      });
      scheduleSync.fixRequested = true;
      scheduleSync.fixAttempt = fixAttempt;
      if (fixAttempt.errors.length === 0) {
        scheduleSync = {
          ...inspectScheduleSyncFn({
            skillRoot,
            workspaceRoot: resolvedWorkspaceRoot,
            workflowId,
            env,
            run,
            openclawCommand,
            openclawTimeoutMs,
          }),
          fixRequested: true,
          fixAttempt,
        };
      }
    } else if (fix) {
      scheduleSync = {
        ...scheduleSync,
        fixRequested: true,
        fixAttempt: {
          applied: [],
          errors: [],
        },
      };
    }
  } catch (error) {
    scheduleSync = {
      skipped: false,
      workspaceRoot: resolvedWorkspaceRoot,
      workflowCount: 0,
      inspections: [],
      driftedWorkflows: [],
      error: error.message || String(error),
      fixRequested: fix,
      fixAttempt: fix ? { applied: [], errors: [] } : null,
    };
  }

  const report = evaluateDoctorChecks({
    skillRoot,
    workspaceRoot: scheduleSync?.workspaceRoot || resolvedWorkspaceRoot || null,
    localPluginExists,
    pluginInfo,
    pluginInfoError,
    telegramPluginInfo,
    telegramPluginError,
    pluginsAllow,
    pluginsAllowError,
    telegramBotToken: getTelegramBotToken(env),
    globalApprovers: resolveTelegramApprovers({ workflow: null, env }),
    configValidation,
    gatewayAccess,
    scheduleSync,
    llmTask,
  });

  return {
    skillRoot,
    workspaceRoot: scheduleSync?.workspaceRoot || resolvedWorkspaceRoot || null,
    gatewayAccess,
    report,
    scheduleSync,
  };
}

function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const result = runDoctor({
    workspaceRoot: flags.workspaceRoot || null,
    workflowId: flags.workflow || null,
    fix: Boolean(flags.fix),
    openclawCommand: flags.openclawCommand || process.env.LOBSTER_WORKFLOWS_OPENCLAW_BIN || 'openclaw',
    openclawTimeoutMs: flags.openclawTimeoutMs ? Number.parseInt(flags.openclawTimeoutMs, 10) : 30000,
  });
  console.log(formatDoctorReport({
    ...result.report,
    workspaceRoot: result.workspaceRoot,
  }, { skillRoot: result.skillRoot }));
  if (result.report.status === 'fail') {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message || String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  evaluateDoctorChecks,
  applyScheduleSyncFixes,
  formatDoctorReport,
  getOverallStatus,
  inspectScheduleSync,
  loadPluginInfo,
  inspectLlmTaskUsage,
  loadPluginsAllow,
  loadStringArrayConfig,
  normalizeComparablePath,
  resolveWorkspaceRoot,
  runDoctor,
  validateOpenClawConfig,
};
