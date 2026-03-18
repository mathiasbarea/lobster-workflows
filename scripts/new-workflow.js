#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const {
  assertWorkflowId,
  ensureArg,
  normalizePath,
  parseArgs,
  printJson,
  titleFromSlug,
  writeFileStrict,
} = require('./_lib');
const { bootstrapWorkspace } = require('./bootstrap-workspace');
const { getWorkflowFileMap } = require('./templates');

function scaffoldWorkflow({ workspaceRoot, workflowId, displayName, description }) {
  assertWorkflowId(workflowId);

  const bootstrap = bootstrapWorkspace({ workspaceRoot });
  const workflowsRoot = path.join(workspaceRoot, 'workflows');
  const workflowRoot = path.join(workflowsRoot, workflowId);

  if (fs.existsSync(workflowRoot)) {
    throw new Error(`Workflow already exists: ${normalizePath(workflowRoot)}`);
  }

  const createdFiles = [];
  const fileMap = getWorkflowFileMap({
    workflowId,
    displayName,
    description,
  });

  for (const [relativePath, content] of fileMap.entries()) {
    const absolutePath = path.join(workflowRoot, relativePath);
    writeFileStrict(absolutePath, content);
    createdFiles.push(normalizePath(absolutePath));
  }

  return {
    workflowId,
    workflowRoot: normalizePath(workflowRoot),
    displayName,
    description,
    bootstrap,
    createdFiles,
  };
}

function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const workspaceRoot = path.resolve(flags.workspaceRoot || process.cwd());
  const workflowId = ensureArg(flags, 'id');
  const displayName = flags.displayName || titleFromSlug(workflowId);
  const description = flags.description || `${displayName} workflow`;
  const result = scaffoldWorkflow({
    workspaceRoot,
    workflowId,
    displayName,
    description,
  });
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
  scaffoldWorkflow,
};
