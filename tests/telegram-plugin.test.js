const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('node:url');

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

async function loadPluginModule() {
  return import(pathToFileURL(path.join(
    __dirname,
    '..',
    'plugin',
    'index.js',
  )).href);
}

async function loadPluginModuleFrom(modulePath) {
  return import(`${pathToFileURL(modulePath).href}?cacheBust=${Date.now()}`);
}

test('telegram plugin parses approval arguments', async () => {
  const plugin = await loadPluginModule();

  assert.deepEqual(plugin.parseApprovalArgs('ap:abcdef123456'), {
    shortAction: 'ap',
    decision: 'approve',
    callbackToken: 'abcdef123456',
  });
  assert.deepEqual(plugin.parseApprovalArgs('reject abcdef123456'), {
    shortAction: 'rj',
    decision: 'reject',
    callbackToken: 'abcdef123456',
  });
  assert.equal(plugin.parseApprovalArgs('hello'), null);
});

test('telegram plugin metadata stays aligned with the manifest id', () => {
  const pluginRoot = path.join(__dirname, '..', 'plugin');
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'openclaw.plugin.json'), 'utf8'));
  const packageManifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8'));

  assert.equal(packageManifest.name, manifest.id);
});

test('telegram plugin resolves installed roots from OPENCLAW_HOME', { concurrency: false }, async () => {
  const openClawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-workflows-openclaw-home-'));
  const skillRoot = path.join(openClawHome, 'skills', 'lobster-workflows');
  const workspaceRoot = path.join(openClawHome, 'workspace');
  const shadowPluginRoot = path.join(openClawHome, 'shadow-plugin');
  const shadowPluginPath = path.join(shadowPluginRoot, 'index.js');
  const originalOpenClawHome = process.env.OPENCLAW_HOME;

  writeFile(path.join(skillRoot, 'SKILL.md'), '---\nname: lobster-workflows\ndescription: test\n---\n');
  writeFile(path.join(skillRoot, 'scripts', 'resume-workflow.js'), '#!/usr/bin/env node\n');
  writeFile(
    shadowPluginPath,
    fs.readFileSync(path.join(__dirname, '..', 'plugin', 'index.js'), 'utf8'),
  );
  fs.mkdirSync(path.join(workspaceRoot, 'workflows'), { recursive: true });

  process.env.OPENCLAW_HOME = openClawHome;
  try {
    const plugin = await loadPluginModuleFrom(shadowPluginPath);

    assert.equal(plugin.resolveSkillRoot({
      pluginConfig: {},
      config: {},
    }), skillRoot);
    assert.equal(plugin.resolveWorkspaceRoot({
      pluginConfig: {},
      config: {},
    }, skillRoot), workspaceRoot);
  } finally {
    if (originalOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = originalOpenClawHome;
    }
  }
});

test('telegram plugin resolves approvals through resume-workflow.js', async () => {
  const plugin = await loadPluginModule();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-workflows-plugin-'));
  const workspaceRoot = path.join(root, 'workspace');
  const skillRoot = path.join(root, 'lobster-workflows');
  const resumeScriptPath = path.join(skillRoot, 'scripts', 'resume-workflow.js');

  writeFile(path.join(skillRoot, 'SKILL.md'), '---\nname: lobster-workflows\ndescription: test\n---\n');
  writeFile(resumeScriptPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
const senderIndex = args.indexOf('--sender-id');
const senderId = senderIndex === -1 ? null : args[senderIndex + 1];
process.stdout.write(JSON.stringify({
  executionId: 'exec_123',
  workflowId: 'approval-smoke',
  status: 'success',
  decision: 'approve',
  senderId,
  editedNotificationCount: 1
}));
`);
  fs.mkdirSync(path.join(workspaceRoot, 'workflows'), { recursive: true });

  let command = null;
  plugin.default({
    pluginConfig: {
      skillRoot,
      workspaceRoot,
    },
    config: {
      agents: {
        defaults: {
          workspace: workspaceRoot,
        },
      },
    },
    registerCommand(nextCommand) {
      command = nextCommand;
    },
  });

  assert.equal(command?.name, 'lwf');
  const response = await command.handler({
    channel: 'telegram',
    senderId: '1234567890',
    args: 'ap:abcdef123456',
  });

  assert.equal(response.text, 'NO_REPLY');
  assert.deepEqual(response.channelData, {
    execApproval: {
      approvalId: 'exec_123',
      approvalSlug: 'approval-smoke',
    },
  });
});

test('telegram plugin surfaces workflow failure messages from resume-workflow.js', async () => {
  const plugin = await loadPluginModule();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-workflows-plugin-failed-'));
  const workspaceRoot = path.join(root, 'workspace');
  const skillRoot = path.join(root, 'lobster-workflows');
  const resumeScriptPath = path.join(skillRoot, 'scripts', 'resume-workflow.js');

  writeFile(path.join(skillRoot, 'SKILL.md'), '---\nname: lobster-workflows\ndescription: test\n---\n');
  writeFile(resumeScriptPath, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  executionId: 'exec_456',
  workflowId: 'approval-smoke',
  status: 'failed',
  decision: 'approve',
  error: {
    message: 'workflow command failed (1): [eval]:1\\nUnterminated string constant'
  }
}));
`);
  fs.mkdirSync(path.join(workspaceRoot, 'workflows'), { recursive: true });

  let command = null;
  plugin.default({
    pluginConfig: {
      skillRoot,
      workspaceRoot,
    },
    config: {
      agents: {
        defaults: {
          workspace: workspaceRoot,
        },
      },
    },
    registerCommand(nextCommand) {
      command = nextCommand;
    },
  });

  const response = await command.handler({
    channel: 'telegram',
    senderId: '1234567890',
    args: 'ap:abcdef123456',
  });

  assert.match(response.text, /Approval failed for approval-smoke \(exec_456\): workflow command failed \(1\): \[eval\]:1/);
});

test('telegram plugin still replies when the original Telegram message was not edited', async () => {
  const plugin = await loadPluginModule();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-workflows-plugin-fallback-'));
  const workspaceRoot = path.join(root, 'workspace');
  const skillRoot = path.join(root, 'lobster-workflows');
  const resumeScriptPath = path.join(skillRoot, 'scripts', 'resume-workflow.js');

  writeFile(path.join(skillRoot, 'SKILL.md'), '---\nname: lobster-workflows\ndescription: test\n---\n');
  writeFile(resumeScriptPath, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  executionId: 'exec_789',
  workflowId: 'approval-smoke',
  status: 'success',
  decision: 'approve',
  editedNotificationCount: 0
}));
`);
  fs.mkdirSync(path.join(workspaceRoot, 'workflows'), { recursive: true });

  let command = null;
  plugin.default({
    pluginConfig: {
      skillRoot,
      workspaceRoot,
    },
    config: {
      agents: {
        defaults: {
          workspace: workspaceRoot,
        },
      },
    },
    registerCommand(nextCommand) {
      command = nextCommand;
    },
  });

  const response = await command.handler({
    channel: 'telegram',
    senderId: '1234567890',
    args: 'ap:abcdef123456',
  });

  assert.equal(response.text, 'Approved approval-smoke (exec_789).');
});

test('telegram plugin rejects non-telegram invocations', async () => {
  const plugin = await loadPluginModule();
  let command = null;
  plugin.default({
    pluginConfig: {},
    config: {},
    registerCommand(nextCommand) {
      command = nextCommand;
    },
  });

  const response = await command.handler({
    channel: 'webchat',
    senderId: '1234567890',
    args: 'ap:abcdef123456',
  });

  assert.match(response.text, /only available from Telegram inline approvals/);
});
