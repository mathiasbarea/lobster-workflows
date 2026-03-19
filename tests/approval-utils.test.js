const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildResolvedTelegramMessage,
  buildTelegramApprovalMessage,
  getTelegramBotToken,
  isTelegramApprovalPluginEnabled,
  resolveTelegramApprovers,
} = require('../scripts/lib/approval-utils');

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

test('approval utils read config from OPENCLAW_HOME', () => {
  const openClawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-workflows-config-home-'));
  writeFile(path.join(openClawHome, 'openclaw.json'), JSON.stringify({
    channels: {
      telegram: {
        botToken: 'telegram-bot-token',
      },
    },
    plugins: {
      entries: {
        'lobster-workflows-telegram': {
          enabled: true,
        },
      },
    },
  }, null, 2));

  const env = {
    OPENCLAW_HOME: openClawHome,
  };

  assert.equal(getTelegramBotToken(env), 'telegram-bot-token');
  assert.equal(isTelegramApprovalPluginEnabled(env), true);
});

test('approval utils require numeric Telegram user ids for approvers', () => {
  const approvers = resolveTelegramApprovers({
    workflow: {
      config: {
        approvals: {
          telegram: {
            approvers: ['@owner', '-1001234567890:topic:42', 'tg:1234567890', '1234567890'],
          },
        },
      },
    },
    env: {},
  });

  assert.deepEqual(approvers, ['1234567890']);
});

test('approval utils prefer workflow Telegram approvers over environment overrides', () => {
  const approvers = resolveTelegramApprovers({
    workflow: {
      config: {
        approvals: {
          telegram: {
            approvers: ['1234567890'],
          },
        },
      },
    },
    env: {
      LOBSTER_WORKFLOWS_TELEGRAM_APPROVERS: '1111111111,2222222222',
    },
  });

  assert.deepEqual(approvers, ['1234567890']);
});

test('approval utils fall back to environment approvers when workflow does not declare them', () => {
  const approvers = resolveTelegramApprovers({
    workflow: {
      config: {},
    },
    env: {
      OPENCLAW_TELEGRAM_APPROVERS: '1111111111,2222222222',
    },
  });

  assert.deepEqual(approvers, ['1111111111', '2222222222']);
});

test('approval utils format Telegram approval messages with clear workflow labels', () => {
  const message = buildTelegramApprovalMessage({
    workflow: {
      workflowId: 'approval-smoke',
      config: {
        identity: {
          displayName: 'Approval Smoke',
        },
      },
    },
    executionId: '2026-03-18T12-00-00-000Z__approval-smoke__abc12345',
    trigger: 'manual',
    scheduledFor: null,
    approval: {
      prompt: 'Review this run.',
      items: [{ orderId: 42 }],
    },
    envelope: null,
    pluginEnabled: true,
  });

  assert.match(message, /^\*\*⏳ Approval required\*\*/m);
  assert.match(message, /\*\*⏳ Approval required\*\*\r?\n\r?\nWorkflow: Approval Smoke/);
  assert.match(message, /Run: Mar 18, 2026, 12:00 UTC/);
  assert.match(message, /Request\r?\nReview this run\./);
  assert.match(message, /Context\r?\n- Order Id: 42/);
  assert.doesNotMatch(message, /\{/);
  assert.match(message, /Tap Approve or Reject below\./);
});

test('approval utils format resolved Telegram messages with visible status heading', () => {
  const message = buildResolvedTelegramMessage({
    workflow: {
      workflowId: 'approval-smoke',
      config: {
        identity: {
          displayName: 'Approval Smoke',
        },
      },
    },
    executionId: '2026-03-18T12-00-00-000Z__approval-smoke__abc12345',
    decision: 'approve',
    status: 'success',
    error: null,
  });

  assert.match(message, /^<b>✅ Approved<\/b>/m);
  assert.match(message, /<b>✅ Approved<\/b>\r?\n\r?\nWorkflow: Approval Smoke/);
  assert.match(message, /Run: Mar 18, 2026, 12:00 UTC/);
  assert.match(message, /Decision: Approved/);
  assert.match(message, /Outcome: Completed successfully/);
});
