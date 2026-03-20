const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  evaluateDoctorChecks,
  formatDoctorReport,
  getOverallStatus,
  runDoctor,
} = require('../scripts/doctor');

test('doctor reports ok when plugin and Telegram prerequisites are in place', () => {
  const skillRoot = path.join(process.cwd(), 'skill-root');
  const report = evaluateDoctorChecks({
    skillRoot,
    localPluginExists: true,
    pluginInfo: {
      enabled: true,
      status: 'loaded',
      commands: ['lwf'],
      source: path.join(skillRoot, 'plugin', 'index.js'),
    },
    telegramPluginInfo: {
      enabled: true,
      status: 'loaded',
    },
    pluginsAllow: {
      present: true,
      values: ['lobster-workflows-telegram'],
    },
    telegramBotToken: 'telegram-bot-token',
    globalApprovers: ['1234567890'],
    configValidation: {
      ok: true,
    },
  });

  assert.equal(report.status, 'ok');
  assert.equal(getOverallStatus(report.checks), 'ok');
  assert.equal(report.checks.every((check) => check.status === 'ok'), true);
});

test('doctor reports warn for missing allowlist pinning and global approvers', () => {
  const skillRoot = path.join(process.cwd(), 'skill-root');
  const report = evaluateDoctorChecks({
    skillRoot,
    localPluginExists: true,
    pluginInfo: {
      enabled: true,
      status: 'loaded',
      commands: ['lwf'],
      source: path.join(skillRoot, 'other-plugin', 'index.js'),
    },
    telegramPluginInfo: {
      enabled: true,
      status: 'loaded',
    },
    pluginsAllow: {
      present: false,
      values: [],
    },
    telegramBotToken: 'telegram-bot-token',
    globalApprovers: [],
    configValidation: {
      ok: true,
    },
  });

  assert.equal(report.status, 'warn');
  assert.equal(report.checks.some((check) => check.id === 'lobster-plugin-source' && check.status === 'warn'), true);
  assert.equal(report.checks.some((check) => check.id === 'plugins-allow' && check.status === 'warn'), true);
  assert.equal(report.checks.some((check) => check.id === 'telegram-approvers' && check.status === 'warn'), true);
});

test('doctor reports warn when workflow schedules drift from OpenClaw cron', () => {
  const skillRoot = path.join(process.cwd(), 'skill-root');
  const report = evaluateDoctorChecks({
    skillRoot,
    workspaceRoot: path.join(process.cwd(), 'workspace'),
    localPluginExists: true,
    pluginInfo: {
      enabled: true,
      status: 'loaded',
      commands: ['lwf'],
      source: path.join(skillRoot, 'plugin', 'index.js'),
    },
    telegramPluginInfo: {
      enabled: true,
      status: 'loaded',
    },
    pluginsAllow: {
      present: true,
      values: ['lobster-workflows-telegram'],
    },
    telegramBotToken: 'telegram-bot-token',
    globalApprovers: ['1234567890'],
    configValidation: {
      ok: true,
    },
    scheduleSync: {
      skipped: false,
      workspaceRoot: path.join(process.cwd(), 'workspace'),
      workflowCount: 1,
      driftedWorkflows: [{
        workflowId: 'daily-report',
        drift: [{
          type: 'missing-active-job',
          scheduleId: 'morning',
        }],
      }],
    },
  });

  assert.equal(report.status, 'warn');
  assert.equal(report.checks.some((check) => check.id === 'schedule-sync' && check.status === 'warn'), true);
});

test('doctor distinguishes gateway RPC health from operator-level scope access', () => {
  const skillRoot = path.join(process.cwd(), 'skill-root');
  const report = evaluateDoctorChecks({
    skillRoot,
    localPluginExists: true,
    pluginInfo: {
      enabled: true,
      status: 'loaded',
      commands: ['lwf'],
      source: path.join(skillRoot, 'plugin', 'index.js'),
    },
    telegramPluginInfo: {
      enabled: true,
      status: 'loaded',
    },
    pluginsAllow: {
      present: true,
      values: ['lobster-workflows-telegram'],
    },
    telegramBotToken: 'telegram-bot-token',
    globalApprovers: ['1234567890'],
    configValidation: {
      ok: true,
    },
    gatewayAccess: {
      gatewayStatus: {
        gateway: {
          bindHost: '127.0.0.1',
          port: 18789,
          probeUrl: 'ws://127.0.0.1:18789',
        },
        port: {
          listeners: [{ address: '127.0.0.1:18789' }],
        },
        rpc: {
          ok: true,
          url: 'ws://127.0.0.1:18789',
        },
      },
      gatewayStatusError: null,
      openclawStatus: {
        gateway: {
          reachable: false,
          error: 'missing scope: operator.read',
        },
      },
      openclawStatusError: null,
    },
  });

  assert.equal(report.status, 'warn');
  assert.equal(report.checks.some((check) => check.id === 'gateway-rpc' && check.status === 'ok'), true);
  assert.equal(report.checks.some((check) => check.id === 'gateway-operator-access' && check.status === 'warn'), true);
});

test('doctor reports fail for missing plugin install and invalid config', () => {
  const skillRoot = path.join(process.cwd(), 'skill-root');
  const report = evaluateDoctorChecks({
    skillRoot,
    localPluginExists: false,
    pluginInfo: null,
    pluginInfoError: 'openclaw plugins info lobster-workflows-telegram failed: plugin not found',
    telegramPluginInfo: {
      enabled: false,
      status: 'disabled',
    },
    pluginsAllow: {
      present: true,
      values: [],
    },
    telegramBotToken: null,
    globalApprovers: [],
    configValidation: {
      ok: false,
      error: 'openclaw config validate failed: invalid config',
    },
  });

  assert.equal(report.status, 'fail');
  assert.equal(report.checks.some((check) => check.id === 'local-plugin-bundle' && check.status === 'fail'), true);
  assert.equal(report.checks.some((check) => check.id === 'lobster-plugin-install' && check.status === 'fail'), true);
  assert.equal(report.checks.some((check) => check.id === 'telegram-channel-plugin' && check.status === 'fail'), true);
  assert.equal(report.checks.some((check) => check.id === 'openclaw-config' && check.status === 'fail'), true);
});

test('doctor warns when optional llm-task readiness is not configured yet', () => {
  const skillRoot = path.resolve(__dirname, '..');
  const result = runDoctor({
    skillRoot,
    workspaceRoot: path.join(process.cwd(), 'workspace'),
    env: {
      TELEGRAM_BOT_TOKEN: 'telegram-bot-token',
      OPENCLAW_TELEGRAM_APPROVERS: '1234567890',
    },
    run: (command, args) => {
      if (args[0] === 'gateway' && args[1] === 'status') {
        return {
          ok: true,
          stdout: JSON.stringify({
            gateway: {
              bindHost: '127.0.0.1',
              port: 18789,
              probeUrl: 'ws://127.0.0.1:18789',
            },
            port: {
              listeners: [{ address: '127.0.0.1:18789' }],
            },
            rpc: {
              ok: true,
              url: 'ws://127.0.0.1:18789',
            },
          }),
          stderr: '',
        };
      }
      if (args[0] === 'status') {
        return {
          ok: true,
          stdout: JSON.stringify({
            gateway: {
              reachable: true,
              error: null,
            },
          }),
          stderr: '',
        };
      }
      if (args[0] === 'plugins' && args[1] === 'info' && args[2] === 'lobster-workflows-telegram') {
        return {
          ok: true,
          stdout: JSON.stringify({
            id: 'lobster-workflows-telegram',
            enabled: true,
            status: 'loaded',
            commands: ['lwf'],
            source: path.join(skillRoot, 'plugin', 'index.js'),
            workspaceDir: path.join(process.cwd(), 'workspace'),
          }),
          stderr: '',
        };
      }
      if (args[0] === 'plugins' && args[1] === 'info' && args[2] === 'telegram') {
        return {
          ok: true,
          stdout: JSON.stringify({
            id: 'telegram',
            enabled: true,
            status: 'loaded',
          }),
          stderr: '',
        };
      }
      if (args[0] === 'plugins' && args[1] === 'info' && args[2] === 'llm-task') {
        return {
          ok: true,
          stdout: JSON.stringify({
            id: 'llm-task',
            enabled: false,
            status: 'disabled',
            error: 'not in allowlist',
          }),
          stderr: '',
        };
      }
      if (args[0] === 'config' && args[1] === 'get' && args[2] === 'plugins.allow') {
        return {
          ok: true,
          stdout: JSON.stringify(['lobster-workflows-telegram']),
          stderr: '',
        };
      }
      if (args[0] === 'config' && args[1] === 'get' && args[2] === 'tools.allow') {
        return {
          ok: false,
          stdout: 'Config path not found: tools.allow',
          stderr: '',
        };
      }
      if (args[0] === 'config' && args[1] === 'get' && args[2] === 'tools.alsoAllow') {
        return {
          ok: false,
          stdout: 'Config path not found: tools.alsoAllow',
          stderr: '',
        };
      }
      if (args[0] === 'config' && args[1] === 'get' && args[2] === 'agents.list') {
        return {
          ok: true,
          stdout: JSON.stringify([{
            id: 'main',
            tools: {
              allow: ['browser'],
            },
          }]),
          stderr: '',
        };
      }
      if (args[0] === 'config' && args[1] === 'validate') {
        return {
          ok: true,
          stdout: '',
          stderr: '',
        };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    },
    inspectLlmTaskUsageFn: () => ({
      skipped: false,
      required: false,
      workflowIds: [],
    }),
    inspectScheduleSyncFn: () => ({
      skipped: false,
      workspaceRoot: path.join(process.cwd(), 'workspace'),
      workflowCount: 0,
      driftedWorkflows: [],
      inSync: true,
    }),
  });

  assert.equal(result.report.status, 'warn');
  assert.equal(result.report.checks.some((check) => check.id === 'llm-task-readiness' && check.status === 'warn'), true);
});

test('doctor reports ok when llm-task-dependent workflows have plugin and tool policy configured', () => {
  const skillRoot = path.resolve(__dirname, '..');
  const result = runDoctor({
    skillRoot,
    workspaceRoot: path.join(process.cwd(), 'workspace'),
    env: {
      TELEGRAM_BOT_TOKEN: 'telegram-bot-token',
      OPENCLAW_TELEGRAM_APPROVERS: '1234567890',
    },
    run: (command, args) => {
      if (args[0] === 'gateway' && args[1] === 'status') {
        return {
          ok: true,
          stdout: JSON.stringify({
            gateway: {
              bindHost: '127.0.0.1',
              port: 18789,
              probeUrl: 'ws://127.0.0.1:18789',
            },
            port: {
              listeners: [{ address: '127.0.0.1:18789' }],
            },
            rpc: {
              ok: true,
              url: 'ws://127.0.0.1:18789',
            },
          }),
          stderr: '',
        };
      }
      if (args[0] === 'status') {
        return {
          ok: true,
          stdout: JSON.stringify({
            gateway: {
              reachable: true,
              error: null,
            },
          }),
          stderr: '',
        };
      }
      if (args[0] === 'plugins' && args[1] === 'info' && args[2] === 'lobster-workflows-telegram') {
        return {
          ok: true,
          stdout: JSON.stringify({
            id: 'lobster-workflows-telegram',
            enabled: true,
            status: 'loaded',
            commands: ['lwf'],
            source: path.join(skillRoot, 'plugin', 'index.js'),
            workspaceDir: path.join(process.cwd(), 'workspace'),
          }),
          stderr: '',
        };
      }
      if (args[0] === 'plugins' && args[1] === 'info' && args[2] === 'telegram') {
        return {
          ok: true,
          stdout: JSON.stringify({
            id: 'telegram',
            enabled: true,
            status: 'loaded',
          }),
          stderr: '',
        };
      }
      if (args[0] === 'plugins' && args[1] === 'info' && args[2] === 'llm-task') {
        return {
          ok: true,
          stdout: JSON.stringify({
            id: 'llm-task',
            enabled: true,
            status: 'loaded',
            toolNames: ['llm-task'],
          }),
          stderr: '',
        };
      }
      if (args[0] === 'config' && args[1] === 'get' && args[2] === 'plugins.allow') {
        return {
          ok: true,
          stdout: JSON.stringify(['lobster-workflows-telegram', 'llm-task']),
          stderr: '',
        };
      }
      if (args[0] === 'config' && args[1] === 'get' && args[2] === 'tools.allow') {
        return {
          ok: false,
          stdout: 'Config path not found: tools.allow',
          stderr: '',
        };
      }
      if (args[0] === 'config' && args[1] === 'get' && args[2] === 'tools.alsoAllow') {
        return {
          ok: false,
          stdout: 'Config path not found: tools.alsoAllow',
          stderr: '',
        };
      }
      if (args[0] === 'config' && args[1] === 'get' && args[2] === 'agents.list') {
        return {
          ok: true,
          stdout: JSON.stringify([{
            id: 'main',
            tools: {
              allow: ['llm-task'],
            },
          }]),
          stderr: '',
        };
      }
      if (args[0] === 'config' && args[1] === 'validate') {
        return {
          ok: true,
          stdout: '',
          stderr: '',
        };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    },
    inspectLlmTaskUsageFn: () => ({
      skipped: false,
      required: true,
      workflowIds: ['idea-workflow'],
    }),
    inspectScheduleSyncFn: () => ({
      skipped: false,
      workspaceRoot: path.join(process.cwd(), 'workspace'),
      workflowCount: 0,
      driftedWorkflows: [],
      inSync: true,
    }),
  });

  assert.equal(result.report.status, 'ok');
  assert.equal(result.report.checks.some((check) => check.id === 'llm-task-plugin' && check.status === 'ok'), true);
  assert.equal(result.report.checks.some((check) => check.id === 'llm-task-tool-policy' && check.status === 'ok'), true);
});

test('doctor reports fail when llm-task-dependent workflows are blocked by plugins.allow', () => {
  const skillRoot = path.join(process.cwd(), 'skill-root');
  const report = evaluateDoctorChecks({
    skillRoot,
    localPluginExists: true,
    pluginInfo: {
      enabled: true,
      status: 'loaded',
      commands: ['lwf'],
      source: path.join(skillRoot, 'plugin', 'index.js'),
    },
    telegramPluginInfo: {
      enabled: true,
      status: 'loaded',
    },
    pluginsAllow: {
      present: true,
      values: ['lobster-workflows-telegram'],
    },
    telegramBotToken: 'telegram-bot-token',
    globalApprovers: ['1234567890'],
    configValidation: {
      ok: true,
    },
    llmTask: {
      required: true,
      workflowIds: ['idea-workflow'],
      pluginInfo: {
        id: 'llm-task',
        enabled: false,
        status: 'disabled',
        error: 'not in allowlist',
      },
      pluginInfoError: null,
      toolPolicyError: null,
      toolAllowed: true,
    },
  });

  assert.equal(report.status, 'fail');
  assert.equal(report.checks.some((check) => check.id === 'llm-task-plugin' && check.status === 'fail'), true);
  assert.equal(report.checks.some((check) => check.id === 'llm-task-tool-policy' && check.status === 'ok'), true);
});

test('doctor reports ok after schedule drift is repaired with --fix', () => {
  const skillRoot = path.resolve(__dirname, '..');
  const inspectCalls = [];
  const result = runDoctor({
    skillRoot,
    workspaceRoot: path.join(process.cwd(), 'workspace'),
    fix: true,
    env: {
      TELEGRAM_BOT_TOKEN: 'telegram-bot-token',
      OPENCLAW_TELEGRAM_APPROVERS: '1234567890',
    },
    run: (command, args) => {
      if (args[0] === 'gateway' && args[1] === 'status') {
        return {
          ok: true,
          stdout: JSON.stringify({
            gateway: {
              bindHost: '127.0.0.1',
              port: 18789,
              probeUrl: 'ws://127.0.0.1:18789',
            },
            port: {
              listeners: [{ address: '127.0.0.1:18789' }],
            },
            rpc: {
              ok: true,
              url: 'ws://127.0.0.1:18789',
            },
          }),
          stderr: '',
        };
      }
      if (args[0] === 'status') {
        return {
          ok: true,
          stdout: JSON.stringify({
            gateway: {
              reachable: true,
              error: null,
            },
          }),
          stderr: '',
        };
      }
      if (args[0] === 'plugins' && args[1] === 'info' && args[2] === 'lobster-workflows-telegram') {
        return {
          ok: true,
          stdout: JSON.stringify({
            id: 'lobster-workflows-telegram',
            enabled: true,
            status: 'loaded',
            commands: ['lwf'],
            source: path.join(skillRoot, 'plugin', 'index.js'),
            workspaceDir: path.join(process.cwd(), 'workspace'),
          }),
          stderr: '',
        };
      }
      if (args[0] === 'plugins' && args[1] === 'info' && args[2] === 'telegram') {
        return {
          ok: true,
          stdout: JSON.stringify({
            id: 'telegram',
            enabled: true,
            status: 'loaded',
          }),
          stderr: '',
        };
      }
      if (args[0] === 'plugins' && args[1] === 'info' && args[2] === 'llm-task') {
        return {
          ok: true,
          stdout: JSON.stringify({
            id: 'llm-task',
            enabled: true,
            status: 'loaded',
            toolNames: ['llm-task'],
          }),
          stderr: '',
        };
      }
      if (args[0] === 'config' && args[1] === 'get' && args[2] === 'plugins.allow') {
        return {
          ok: true,
          stdout: JSON.stringify(['lobster-workflows-telegram', 'llm-task']),
          stderr: '',
        };
      }
      if (args[0] === 'config' && args[1] === 'get' && args[2] === 'tools.allow') {
        return {
          ok: false,
          stdout: 'Config path not found: tools.allow',
          stderr: '',
        };
      }
      if (args[0] === 'config' && args[1] === 'get' && args[2] === 'tools.alsoAllow') {
        return {
          ok: false,
          stdout: 'Config path not found: tools.alsoAllow',
          stderr: '',
        };
      }
      if (args[0] === 'config' && args[1] === 'get' && args[2] === 'agents.list') {
        return {
          ok: true,
          stdout: JSON.stringify([{
            id: 'main',
            tools: {
              allow: ['llm-task'],
            },
          }]),
          stderr: '',
        };
      }
      if (args[0] === 'config' && args[1] === 'validate') {
        return {
          ok: true,
          stdout: '',
          stderr: '',
        };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    },
    inspectScheduleSyncFn: () => {
      inspectCalls.push('inspect');
      if (inspectCalls.length === 1) {
        return {
          skipped: false,
          workspaceRoot: path.join(process.cwd(), 'workspace'),
          workflowCount: 1,
          driftedWorkflows: [{
            workflowId: 'daily-report',
            drift: [{
              type: 'missing-active-job',
              scheduleId: 'morning',
            }],
          }],
          inSync: false,
        };
      }
      return {
        skipped: false,
        workspaceRoot: path.join(process.cwd(), 'workspace'),
        workflowCount: 1,
        driftedWorkflows: [],
        inSync: true,
      };
    },
    applyScheduleSyncFixesFn: () => ({
      applied: [{
        workflowId: 'daily-report',
        operations: [{ type: 'add', scheduleId: 'morning', jobId: 'job-1' }],
      }],
      errors: [],
    }),
  });

  assert.equal(result.report.status, 'ok');
  assert.equal(result.report.checks.some((check) => check.id === 'schedule-sync' && check.status === 'ok'), true);
  assert.equal(inspectCalls.length, 2);
});

test('doctor reports fail when schedule drift inspection cannot reach cron state', () => {
  const skillRoot = path.resolve(__dirname, '..');
  const result = runDoctor({
    skillRoot,
    workspaceRoot: path.join(process.cwd(), 'workspace'),
    env: {
      TELEGRAM_BOT_TOKEN: 'telegram-bot-token',
      OPENCLAW_TELEGRAM_APPROVERS: '1234567890',
    },
    run: (command, args) => {
      if (args[0] === 'gateway' && args[1] === 'status') {
        return {
          ok: true,
          stdout: JSON.stringify({
            gateway: {
              bindHost: '127.0.0.1',
              port: 18789,
              probeUrl: 'ws://127.0.0.1:18789',
            },
            port: {
              listeners: [{ address: '127.0.0.1:18789' }],
            },
            rpc: {
              ok: true,
              url: 'ws://127.0.0.1:18789',
            },
          }),
          stderr: '',
        };
      }
      if (args[0] === 'status') {
        return {
          ok: true,
          stdout: JSON.stringify({
            gateway: {
              reachable: false,
              error: 'missing scope: operator.read',
            },
          }),
          stderr: '',
        };
      }
      if (args[0] === 'plugins' && args[1] === 'info' && args[2] === 'lobster-workflows-telegram') {
        return {
          ok: true,
          stdout: JSON.stringify({
            id: 'lobster-workflows-telegram',
            enabled: true,
            status: 'loaded',
            commands: ['lwf'],
            source: path.join(skillRoot, 'plugin', 'index.js'),
            workspaceDir: path.join(process.cwd(), 'workspace'),
          }),
          stderr: '',
        };
      }
      if (args[0] === 'plugins' && args[1] === 'info' && args[2] === 'telegram') {
        return {
          ok: true,
          stdout: JSON.stringify({
            id: 'telegram',
            enabled: true,
            status: 'loaded',
          }),
          stderr: '',
        };
      }
      if (args[0] === 'plugins' && args[1] === 'info' && args[2] === 'llm-task') {
        return {
          ok: true,
          stdout: JSON.stringify({
            id: 'llm-task',
            enabled: true,
            status: 'loaded',
            toolNames: ['llm-task'],
          }),
          stderr: '',
        };
      }
      if (args[0] === 'config' && args[1] === 'get' && args[2] === 'plugins.allow') {
        return {
          ok: true,
          stdout: JSON.stringify(['lobster-workflows-telegram', 'llm-task']),
          stderr: '',
        };
      }
      if (args[0] === 'config' && args[1] === 'get' && args[2] === 'tools.allow') {
        return {
          ok: false,
          stdout: 'Config path not found: tools.allow',
          stderr: '',
        };
      }
      if (args[0] === 'config' && args[1] === 'get' && args[2] === 'tools.alsoAllow') {
        return {
          ok: false,
          stdout: 'Config path not found: tools.alsoAllow',
          stderr: '',
        };
      }
      if (args[0] === 'config' && args[1] === 'get' && args[2] === 'agents.list') {
        return {
          ok: true,
          stdout: JSON.stringify([{
            id: 'main',
            tools: {
              allow: ['llm-task'],
            },
          }]),
          stderr: '',
        };
      }
      if (args[0] === 'config' && args[1] === 'validate') {
        return {
          ok: true,
          stdout: '',
          stderr: '',
        };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    },
    inspectScheduleSyncFn: () => {
      throw new Error('Failed to list cron jobs: gateway connect failed');
    },
  });

  assert.equal(result.report.status, 'fail');
  assert.equal(result.report.checks.some((check) => check.id === 'schedule-sync' && check.status === 'fail'), true);
  assert.equal(result.report.checks.some((check) => check.id === 'gateway-rpc' && check.status === 'ok'), true);
  assert.equal(result.report.checks.some((check) => check.id === 'gateway-operator-access' && check.status === 'warn'), true);
});

test('doctor report formatter includes statuses and hints', () => {
  const reportText = formatDoctorReport({
    status: 'warn',
    checks: [
      {
        id: 'plugins-allow',
        status: 'warn',
        summary: 'plugins.allow is not configured.',
        hint: 'Run `node scripts/install-telegram-plugin.js`.',
      },
    ],
  }, {
    skillRoot: '/tmp/lobster-workflows',
  });

  assert.match(reportText, /Lobster Workflows Doctor: WARN/u);
  assert.match(reportText, /\[WARN\] plugins\.allow is not configured\./u);
  assert.match(reportText, /Run `node scripts\/install-telegram-plugin\.js`\./u);
});
