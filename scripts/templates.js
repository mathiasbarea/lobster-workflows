const path = require('path');
const { escapeForSingleQuotedJs, normalizePath } = require('./_lib');

function getSharedTemplates() {
  return {
    'README.md': `# Shared Workflow Helpers

This folder contains workflow-agnostic helpers that may be imported by multiple workflows.

Rules:

- Keep domain-specific workflow logic out of this folder
- Keep runtime state out of this folder
- Prefer small modules with stable APIs
`,
    'contracts.js': `class WorkflowError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'WorkflowError';
    this.code = code;
    this.details = details;
  }
}

function now() {
  return new Date().toISOString();
}

function success(action, data, meta = {}) {
  return {
    ok: true,
    action,
    generatedAt: now(),
    data,
    meta,
  };
}

function failure(action, error) {
  if (error instanceof WorkflowError) {
    return {
      ok: false,
      action,
      generatedAt: now(),
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    };
  }

  return {
    ok: false,
    action,
    generatedAt: now(),
    error: {
      code: 'unexpected_error',
      message: error && error.message ? error.message : String(error),
      details: {},
    },
  };
}

function ensureRequired(name, value) {
  if (!value) {
    throw new WorkflowError('missing_required_arg', \`Missing required --\${name}\`, {
      arg: name,
    });
  }
}

module.exports = {
  WorkflowError,
  ensureRequired,
  failure,
  success,
};
`,
    'fs-utils.js': `const fs = require('fs');
const path = require('path');

function normalizePath(filePath) {
  return String(filePath).replace(/\\\\/g, '/');
}

function fileExists(filePath) {
  return fs.existsSync(filePath);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonIfExists(filePath, fallback = null) {
  if (!fileExists(filePath)) return fallback;
  return readJson(filePath);
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, \`\${JSON.stringify(value, null, 2)}\\n\`, 'utf8');
}

module.exports = {
  ensureDir,
  fileExists,
  normalizePath,
  readJson,
  readJsonIfExists,
  writeJson,
};
`,
    'process-runner.js': `const { spawnSync } = require('child_process');

function toCommandDisplay(command, args) {
  return [command, ...args].map((part) => JSON.stringify(String(part))).join(' ');
}

function runCommand(command, args = [], options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
    timeout: options.timeoutMs,
    killSignal: options.killSignal || 'SIGTERM',
  });
  const durationMs = Date.now() - startedAt;
  const errorText = result.error ? String(result.error.message || result.error) : '';
  const timedOut = Boolean(
    (options.timeoutMs && result.error && /timed out|ETIMEDOUT/i.test(errorText)) ||
    result.signal === 'SIGTERM'
  );

  return {
    ok: result.status === 0 && !result.error,
    command,
    args,
    commandDisplay: toCommandDisplay(command, args),
    cwd: options.cwd || process.cwd(),
    exitCode: result.status,
    signal: result.signal || null,
    durationMs,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    timedOut,
    errorMessage: errorText || null,
  };
}

function runNodeScript(scriptPath, args = [], options = {}) {
  return runCommand(process.execPath, [scriptPath, ...args], options);
}

module.exports = {
  runCommand,
  runNodeScript,
};
`,
    'artifact-checks.js': `const fs = require('fs');

function listMissingFiles(paths) {
  return paths.filter((filePath) => !fs.existsSync(filePath));
}

function ensureFilesExist(paths) {
  const missing = listMissingFiles(paths);
  return {
    ok: missing.length === 0,
    missing,
  };
}

module.exports = {
  ensureFilesExist,
  listMissingFiles,
};
`,
    'openclaw-client.js': `const fs = require('fs');
const os = require('os');
const path = require('path');

function readOpenClawConfigFallback() {
  try {
    const configHome = process.env.OPENCLAW_HOME || process.env.CODEX_HOME || process.env.HOME || process.env.USERPROFILE || os.homedir();
    const configPath = path.join(configHome, '.openclaw', 'openclaw.json');
    if (!fs.existsSync(configPath)) return null;
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

function resolveOpenClawAccess() {
  const config = readOpenClawConfigFallback() || {};
  const port = config?.gateway?.port || 18789;
  return {
    baseUrl: process.env.OPENCLAW_URL || process.env.CLAWD_URL || \`http://127.0.0.1:\${port}\`,
    token: process.env.OPENCLAW_TOKEN || process.env.CLAWD_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN || config?.gateway?.auth?.token || '',
  };
}

async function invokeTool({ tool, action, args }) {
  const { baseUrl, token } = resolveOpenClawAccess();
  const response = await fetch(new URL('/tools/invoke', baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: \`Bearer \${token}\` } : {}),
    },
    body: JSON.stringify({ tool, action, args }),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(\`OpenClaw /tools/invoke failed (\${response.status} \${response.statusText})\\n\${raw}\`);
  }

  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(\`Non-JSON response from OpenClaw: \${raw}\`);
  }
}

function extractToolJson(parsed) {
  return parsed?.result?.details?.json || parsed?.result?.json || parsed?.result || parsed?.details?.json || parsed?.json || parsed;
}

module.exports = {
  extractToolJson,
  invokeTool,
  resolveOpenClawAccess,
};
`,
  };
}

function createWorkflowConfigContent({ workflowId, displayName, description }) {
  return `module.exports = {
  identity: {
    workflowId: '${escapeForSingleQuotedJs(workflowId)}',
    displayName: '${escapeForSingleQuotedJs(displayName)}',
    description: '${escapeForSingleQuotedJs(description)}',
  },
  runtime: {
    runnerType: 'lobster',
    entrypoint: '${escapeForSingleQuotedJs(workflowId)}.lobster',
    defaultAction: 'run',
    workingDirectory: '.',
    defaultInputs: {},
  },
  schedules: [],
  result: {
    resultType: 'object',
    resultDescription: 'Canonical workflow result payload',
    latestResultPolicy: 'on-success',
    extractor: {
      dataPath: 'output.0.data',
    },
  },
  observability: {
    successCondition: {
      ok: true,
      status: 'ok',
    },
    defaultTimeoutMs: 30000,
  },
};
`;
}

function createWorkflowReadmeContent({ workflowId, displayName }) {
  return `# ${displayName}

Managed Lobster workflow scaffold.

## Files

- \`workflow.config.js\`: workflow identity, runtime, schedules, result, and observability
- \`${workflowId}.lobster\`: Lobster workflow entrypoint
- \`run-workflow.js\`: Node runner for workflow actions
- \`lib/actions/\`: workflow actions
- \`tests/\`: smoke tests

## Run

\`\`\`bash
node run-workflow.js --action run
\`\`\`

## Schedules

Define schedules in \`workflow.config.js\`. The scaffold starts with no schedules.
`;
}

function createWorkflowContractContent({ workflowId }) {
  return `# Contract

## Identity

- workflowId: \`${workflowId}\`

## Actions

- \`run\`: default scaffold action

## Result

The scaffold returns a canonical object result with:

- \`workflowId\`
- \`status\`
- \`receivedInput\`

## Side Effects

The scaffold action has no side effects. Replace it with workflow-specific behavior as the implementation evolves.
`;
}

function createWorkflowLobsterContent({ workflowId }) {
  return `name: ${workflowId}
steps:
  - id: run
    run: >
      node ./run-workflow.js
      --action run
`;
}

function createWorkflowRunnerContent() {
  return `#!/usr/bin/env node
const { success, failure, WorkflowError } = require('../_shared/contracts');
const { run } = require('./lib/actions/run');
const config = require('./workflow.config');

const ACTIONS = {
  run,
};

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

async function runAction({ action, flags, stdinText }) {
  const resolvedAction = action || config.runtime.defaultAction || 'run';
  const handler = ACTIONS[resolvedAction];
  if (!handler) {
    throw new WorkflowError('unknown_action', \`Unknown --action: \${resolvedAction}\`, {
      availableActions: Object.keys(ACTIONS),
    });
  }

  let input = {};
  if (stdinText && stdinText.trim()) {
    try {
      input = JSON.parse(stdinText);
    } catch (error) {
      throw new WorkflowError('invalid_stdin_json', 'STDIN must be valid JSON', {
        message: error.message,
      });
    }
  }

  const data = await handler({
    config,
    flags,
    input,
    workflowRoot: __dirname,
  });

  return success(resolvedAction, data, {
    workflowId: config.identity.workflowId,
  });
}

async function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const stdinText = await readStdin();
  const result = await runAction({
    action: flags.action,
    flags,
    stdinText,
  });
  process.stdout.write(\`\${JSON.stringify(result, null, 2)}\\n\`);
}

if (require.main === module) {
  main().catch((error) => {
    const flags = parseArgs(process.argv.slice(2));
    const result = failure(flags.action || null, error);
    process.stderr.write(\`\${JSON.stringify(result, null, 2)}\\n\`);
    process.exit(1);
  });
}

module.exports = {
  ACTIONS,
  main,
  parseArgs,
  runAction,
};
`;
}

function createWorkflowActionContent({ workflowId }) {
  return `async function run({ input }) {
  return {
    workflowId: '${escapeForSingleQuotedJs(workflowId)}',
    status: 'ok',
    receivedInput: input,
  };
}

module.exports = {
  run,
};
`;
}

function createWorkflowSmokeTestContent({ workflowId }) {
  return `const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../workflow.config');
const { runAction } = require('../run-workflow');

test('workflow config exposes identity', () => {
  assert.equal(config.identity.workflowId, '${escapeForSingleQuotedJs(workflowId)}');
  assert.equal(Array.isArray(config.schedules), true);
});

test('default run action returns success envelope', async () => {
  const result = await runAction({
    action: 'run',
    flags: {},
    stdinText: JSON.stringify({ hello: 'world' }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.workflowId, '${escapeForSingleQuotedJs(workflowId)}');
  assert.equal(result.data.status, 'ok');
  assert.deepEqual(result.data.receivedInput, { hello: 'world' });
  assert.equal(config.runtime.runnerType, 'lobster');
  assert.equal(config.runtime.entrypoint, '${escapeForSingleQuotedJs(workflowId)}.lobster');
});
`;
}

function getWorkflowFileMap({ workflowId, displayName, description }) {
  return new Map([
    ['workflow.config.js', createWorkflowConfigContent({ workflowId, displayName, description })],
    ['README.md', createWorkflowReadmeContent({ workflowId, displayName })],
    ['CONTRACT.md', createWorkflowContractContent({ workflowId })],
    [`${workflowId}.lobster`, createWorkflowLobsterContent({ workflowId })],
    ['run-workflow.js', createWorkflowRunnerContent()],
    [path.join('lib', 'actions', 'run.js'), createWorkflowActionContent({ workflowId })],
    [path.join('tests', 'smoke.test.js'), createWorkflowSmokeTestContent({ workflowId })],
  ]);
}

module.exports = {
  getSharedTemplates,
  getWorkflowFileMap,
};
