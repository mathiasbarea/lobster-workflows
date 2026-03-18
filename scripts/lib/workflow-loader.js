const fs = require('fs');
const path = require('path');

const {
  getWorkflowConfigPath,
  getWorkflowRoot,
  getWorkflowsRoot,
} = require('./paths');

function validateWorkflowConfig(config, workflowId) {
  const required = ['identity', 'runtime', 'schedules', 'result', 'observability'];
  for (const key of required) {
    if (!(key in config)) {
      throw new Error(`Workflow ${workflowId} is missing config section: ${key}`);
    }
  }

  if (config.identity.workflowId !== workflowId) {
    throw new Error(`Workflow config workflowId mismatch for ${workflowId}`);
  }
}

function listWorkflowIds(workspaceRoot) {
  const workflowsRoot = getWorkflowsRoot(workspaceRoot);
  if (!fs.existsSync(workflowsRoot)) return [];

  return fs.readdirSync(workflowsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('_'))
    .sort();
}

function loadWorkflow(workspaceRoot, workflowId) {
  const workflowRoot = getWorkflowRoot(workspaceRoot, workflowId);
  const configPath = getWorkflowConfigPath(workspaceRoot, workflowId);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Workflow config not found: ${configPath}`);
  }

  delete require.cache[require.resolve(configPath)];
  const config = require(configPath);
  validateWorkflowConfig(config, workflowId);

  return {
    workflowId,
    workflowRoot,
    configPath,
    entrypointPath: path.join(workflowRoot, config.runtime.entrypoint),
    config,
  };
}

module.exports = {
  listWorkflowIds,
  loadWorkflow,
};
