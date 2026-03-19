#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const {
  getTelegramBotToken,
  parseJsonFromMixedStdout,
  resolveTelegramApprovers,
} = require('./lib/approval-utils');
const { runCommand } = require('./lib/process-utils');
const {
  PLUGIN_ID,
  isMissingConfigPath,
  parsePluginsAllowJson,
} = require('./install-telegram-plugin');

const STOCK_TELEGRAM_PLUGIN_ID = 'telegram';

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

function describeCommandFailure(step, result) {
  const stderr = String(result?.stderr || '').trim();
  const stdout = String(result?.stdout || '').trim();
  const details = stderr || stdout || result?.errorMessage || 'Unknown error';
  return `${step} failed: ${details}`;
}

function parseJsonCommandOutput(step, result) {
  if (!result.ok) {
    throw new Error(describeCommandFailure(step, result));
  }

  const parsed = parseJsonFromMixedStdout(result.stdout);
  if (!parsed) {
    throw new Error(`${step} did not return valid JSON output.`);
  }

  return parsed;
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
  const result = run(env.LOBSTER_WORKFLOWS_OPENCLAW_BIN || 'openclaw', ['config', 'get', 'plugins.allow', '--json'], {
    cwd,
    env,
    timeoutMs: 30000,
  });

  if (result.ok) {
    return {
      present: true,
      values: parsePluginsAllowJson(result.stdout),
    };
  }

  if (isMissingConfigPath(result)) {
    return {
      present: false,
      values: [],
    };
  }

  throw new Error(describeCommandFailure('Reading plugins.allow', result));
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

function evaluateDoctorChecks({
  skillRoot,
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

  return {
    status: getOverallStatus(checks),
    checks,
  };
}

function formatDoctorReport(report, { skillRoot }) {
  const lines = [
    `Lobster Workflows Doctor: ${report.status.toUpperCase()}`,
    `Skill root: ${skillRoot}`,
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

function runDoctor({ env = process.env, run = runCommand } = {}) {
  const skillRoot = path.resolve(__dirname, '..');
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
  const report = evaluateDoctorChecks({
    skillRoot,
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
  });

  return {
    skillRoot,
    report,
  };
}

function main() {
  const result = runDoctor();
  console.log(formatDoctorReport(result.report, { skillRoot: result.skillRoot }));
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
  formatDoctorReport,
  getOverallStatus,
  loadPluginInfo,
  loadPluginsAllow,
  normalizeComparablePath,
  runDoctor,
  validateOpenClawConfig,
};
