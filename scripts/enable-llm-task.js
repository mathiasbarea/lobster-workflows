#!/usr/bin/env node

const path = require('path');

const { parseArgs } = require('./_lib');
const { runCommand } = require('./lib/process-utils');
const {
  isMissingConfigPath,
  parsePluginsAllowJson,
} = require('./install-telegram-plugin');

const LLM_TASK_PLUGIN_ID = 'llm-task';
const DEFAULT_AGENT_ID = 'main';

function parseAgentsListJson(rawValue) {
  const text = String(rawValue || '').trim();
  if (!text) return [];

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse agents.list as JSON: ${error.message}`);
  }

  if (parsed == null) return [];
  if (!Array.isArray(parsed)) {
    throw new Error('Expected agents.list to be a JSON array.');
  }

  return parsed;
}

function mergeStringAllowlist(existingValues, valueToAdd) {
  const normalized = (Array.isArray(existingValues) ? existingValues : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return [...new Set([...normalized, String(valueToAdd || '').trim()].filter(Boolean))];
}

function mergeAgentToolAllowlist(agentsList, {
  agentId = DEFAULT_AGENT_ID,
  toolName = LLM_TASK_PLUGIN_ID,
} = {}) {
  const normalizedAgents = Array.isArray(agentsList) ? agentsList.map((agent) => {
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) return {};
    return { ...agent };
  }) : [];
  const targetId = String(agentId || DEFAULT_AGENT_ID).trim() || DEFAULT_AGENT_ID;
  const existingIndex = normalizedAgents.findIndex((agent) => String(agent.id || '').trim() === targetId);

  if (existingIndex === -1) {
    return [
      ...normalizedAgents,
      {
        id: targetId,
        tools: {
          allow: [toolName],
        },
      },
    ];
  }

  const targetAgent = normalizedAgents[existingIndex];
  const nextTools = targetAgent.tools && typeof targetAgent.tools === 'object' && !Array.isArray(targetAgent.tools)
    ? { ...targetAgent.tools }
    : {};
  nextTools.allow = mergeStringAllowlist(nextTools.allow, toolName);

  normalizedAgents[existingIndex] = {
    ...targetAgent,
    tools: nextTools,
  };
  return normalizedAgents;
}

function describeCommandFailure(step, result) {
  const stderr = String(result?.stderr || '').trim();
  const stdout = String(result?.stdout || '').trim();
  const details = stderr || stdout || result?.errorMessage || 'Unknown error';
  return `${step} failed (${result.command} ${result.args.join(' ')}): ${details}`;
}

function loadConfigArray(configPath, { cwd, runCommandFn = runCommand }) {
  const result = runCommandFn('openclaw', ['config', 'get', configPath, '--json'], {
    cwd,
    timeoutMs: 30000,
  });

  if (result.ok) {
    return {
      present: true,
      values: configPath === 'agents.list'
        ? parseAgentsListJson(result.stdout)
        : parsePluginsAllowJson(result.stdout),
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

function setConfigJson(configPath, value, { cwd, runCommandFn = runCommand }) {
  const result = runCommandFn('openclaw', ['config', 'set', configPath, JSON.stringify(value), '--strict-json'], {
    cwd,
    timeoutMs: 30000,
  });
  if (!result.ok) {
    throw new Error(describeCommandFailure(`Updating ${configPath}`, result));
  }
}

function enableLlmTask({
  agentId = DEFAULT_AGENT_ID,
  runCommandFn = runCommand,
  skillRoot = path.resolve(__dirname, '..'),
} = {}) {
  setConfigJson(`plugins.entries.${LLM_TASK_PLUGIN_ID}.enabled`, true, {
    cwd: skillRoot,
    runCommandFn,
  });

  const currentPluginsAllow = loadConfigArray('plugins.allow', {
    cwd: skillRoot,
    runCommandFn,
  });
  const mergedPluginsAllow = currentPluginsAllow.present
    ? mergeStringAllowlist(currentPluginsAllow.values, LLM_TASK_PLUGIN_ID)
    : null;
  if (mergedPluginsAllow) {
    setConfigJson('plugins.allow', mergedPluginsAllow, {
      cwd: skillRoot,
      runCommandFn,
    });
  }

  const currentAgentsList = loadConfigArray('agents.list', {
    cwd: skillRoot,
    runCommandFn,
  });
  const mergedAgentsList = mergeAgentToolAllowlist(currentAgentsList.values, {
    agentId,
    toolName: LLM_TASK_PLUGIN_ID,
  });
  setConfigJson('agents.list', mergedAgentsList, {
    cwd: skillRoot,
    runCommandFn,
  });

  return {
    pluginId: LLM_TASK_PLUGIN_ID,
    agentId,
    pluginsAllowPresent: currentPluginsAllow.present,
    pluginsAllow: mergedPluginsAllow,
    agentsList: mergedAgentsList,
  };
}

function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const result = enableLlmTask({
    agentId: flags.agent || DEFAULT_AGENT_ID,
  });

  console.log(`Enabled ${result.pluginId} in plugins.entries.`);
  if (result.pluginsAllowPresent) {
    console.log(`plugins.allow = ${JSON.stringify(result.pluginsAllow)}`);
  } else {
    console.log('plugins.allow was not configured, so it was left unchanged.');
  }
  console.log(`agents.list updated for agent "${result.agentId}" to allow ${result.pluginId}.`);
  console.log('Restart the OpenClaw gateway before retrying workflows that invoke llm-task.');
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
  DEFAULT_AGENT_ID,
  LLM_TASK_PLUGIN_ID,
  enableLlmTask,
  mergeAgentToolAllowlist,
  mergeStringAllowlist,
  parseAgentsListJson,
};
