#!/usr/bin/env node
const path = require('path');

const {
  ensureDir,
  normalizePath,
  parseArgs,
  printJson,
  writeFileIfMissing,
} = require('./_lib');
const { getSharedTemplates } = require('./templates');

const EXECUTION_DIRS = [
  'runs',
  'daily',
  'latest',
  'schedules',
  'sync',
];

function bootstrapWorkspace({ workspaceRoot }) {
  const workflowsRoot = path.join(workspaceRoot, 'workflows');
  const sharedRoot = path.join(workflowsRoot, '_shared');
  const executionsRoot = path.join(workflowsRoot, '_executions');
  const createdDirectories = [];
  const existingDirectories = [];
  const createdFiles = [];
  const existingFiles = [];

  for (const dirPath of [workflowsRoot, sharedRoot, executionsRoot, ...EXECUTION_DIRS.map((dirName) => path.join(executionsRoot, dirName))]) {
    if (require('fs').existsSync(dirPath)) {
      existingDirectories.push(normalizePath(dirPath));
      continue;
    }
    ensureDir(dirPath);
    createdDirectories.push(normalizePath(dirPath));
  }

  const gitIgnorePath = path.join(workflowsRoot, '.gitignore');
  if (writeFileIfMissing(gitIgnorePath, '_executions/\n')) {
    createdFiles.push(normalizePath(gitIgnorePath));
  } else {
    existingFiles.push(normalizePath(gitIgnorePath));
  }

  for (const [relativePath, content] of Object.entries(getSharedTemplates())) {
    const filePath = path.join(sharedRoot, relativePath);
    if (writeFileIfMissing(filePath, content)) {
      createdFiles.push(normalizePath(filePath));
    } else {
      existingFiles.push(normalizePath(filePath));
    }
  }

  return {
    workspaceRoot: normalizePath(workspaceRoot),
    workflowsRoot: normalizePath(workflowsRoot),
    sharedRoot: normalizePath(sharedRoot),
    executionsRoot: normalizePath(executionsRoot),
    createdDirectories,
    existingDirectories,
    createdFiles,
    existingFiles,
  };
}

function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const workspaceRoot = path.resolve(flags.workspaceRoot || process.cwd());
  const result = bootstrapWorkspace({ workspaceRoot });
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
  bootstrapWorkspace,
  EXECUTION_DIRS,
};
