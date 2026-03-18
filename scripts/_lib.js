const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) continue;
    const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    index += 1;
  }
  return flags;
}

function ensureArg(flags, name) {
  const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  const value = flags[key];
  if (!value) {
    throw new Error(`Missing required --${name}`);
  }
  return value;
}

function normalizePath(targetPath) {
  return String(targetPath).replace(/\\/g, '/');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function fileExists(filePath) {
  return fs.existsSync(filePath);
}

function writeFileIfMissing(filePath, content) {
  if (fileExists(filePath)) return false;
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function writeFileStrict(filePath, content) {
  if (fileExists(filePath)) {
    throw new Error(`Refusing to overwrite existing file: ${normalizePath(filePath)}`);
  }
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

function titleFromSlug(slug) {
  return String(slug)
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function assertWorkflowId(workflowId) {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(workflowId || ''))) {
    throw new Error('workflowId must be lowercase kebab-case');
  }
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function escapeForSingleQuotedJs(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

module.exports = {
  assertWorkflowId,
  ensureArg,
  ensureDir,
  escapeForSingleQuotedJs,
  fileExists,
  normalizePath,
  parseArgs,
  printJson,
  titleFromSlug,
  writeFileIfMissing,
  writeFileStrict,
};
