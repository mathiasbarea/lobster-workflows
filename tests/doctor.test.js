const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  evaluateDoctorChecks,
  formatDoctorReport,
  getOverallStatus,
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
