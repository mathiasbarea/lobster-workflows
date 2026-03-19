#!/usr/bin/env node

const path = require('path');

const { runCommand } = require('./lib/process-utils');

const PLUGIN_ID = 'lobster-workflows-telegram';

function parsePluginsAllowJson(rawValue) {
  const text = String(rawValue || '').trim();
  if (!text) return [];

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse plugins.allow as JSON: ${error.message}`);
  }

  if (parsed == null) return [];
  if (!Array.isArray(parsed)) {
    throw new Error('Expected plugins.allow to be a JSON array.');
  }

  return parsed
    .map((value) => String(value || '').trim())
    .filter(Boolean);
}

function mergePluginAllowlist(existingPlugins, pluginId = PLUGIN_ID) {
  return [...new Set([...existingPlugins, pluginId])];
}

function isMissingConfigPath(result) {
  const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
  return /Config path not found:/iu.test(combinedOutput);
}

function describeCommandFailure(step, result) {
  const stderr = (result.stderr || '').trim();
  const stdout = (result.stdout || '').trim();
  const details = stderr || stdout || result.errorMessage || 'Unknown error';
  return `${step} failed (${result.command} ${result.args.join(' ')}): ${details}`;
}

function main() {
  const skillRoot = path.resolve(__dirname, '..');
  const pluginRoot = path.join(skillRoot, 'plugin');

  const installResult = runCommand('openclaw', ['plugins', 'install', '--link', pluginRoot], {
    cwd: skillRoot,
    timeoutMs: 60000,
  });
  if (!installResult.ok) {
    throw new Error(describeCommandFailure('Plugin install', installResult));
  }

  const currentAllowResult = runCommand('openclaw', ['config', 'get', 'plugins.allow', '--json'], {
    cwd: skillRoot,
    timeoutMs: 30000,
  });

  let currentAllow = [];
  if (currentAllowResult.ok) {
    currentAllow = parsePluginsAllowJson(currentAllowResult.stdout);
  } else if (!isMissingConfigPath(currentAllowResult)) {
    throw new Error(describeCommandFailure('Reading plugins.allow', currentAllowResult));
  }

  const mergedAllow = mergePluginAllowlist(currentAllow);
  const mergedAllowJson = JSON.stringify(mergedAllow);

  const setAllowResult = runCommand('openclaw', ['config', 'set', 'plugins.allow', mergedAllowJson, '--strict-json'], {
    cwd: skillRoot,
    timeoutMs: 30000,
  });
  if (!setAllowResult.ok) {
    throw new Error(describeCommandFailure('Updating plugins.allow', setAllowResult));
  }

  console.log(`Installed plugin link for ${PLUGIN_ID}.`);
  console.log(`plugins.allow = ${mergedAllowJson}`);
  console.log('Restart the OpenClaw gateway to load the plugin.');
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
  PLUGIN_ID,
  isMissingConfigPath,
  mergePluginAllowlist,
  parsePluginsAllowJson,
};
