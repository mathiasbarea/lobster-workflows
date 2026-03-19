const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { runCommand } = require('./process-utils');

function resolveOpenClawHome(env = process.env) {
  const explicitHome = String(env.OPENCLAW_HOME || env.CODEX_HOME || '').trim();
  if (explicitHome) return explicitHome;

  const userHome = env.HOME || env.USERPROFILE || os.homedir();
  if (!userHome) return null;
  return path.join(userHome, '.openclaw');
}

function isApprovalEnvelope(envelope) {
  return Boolean(
    envelope &&
    envelope.ok === true &&
    envelope.status === 'needs_approval' &&
    envelope.requiresApproval &&
    envelope.requiresApproval.resumeToken
  );
}

function isCancelledEnvelope(envelope) {
  return Boolean(envelope && envelope.status === 'cancelled');
}

function createApprovalCallbackToken() {
  return crypto.randomBytes(6).toString('hex');
}

function parseApprovalCallbackData(text) {
  const value = String(text || '').trim();
  const normalized = value.startsWith('callback_data:') ? value.slice('callback_data:'.length).trim() : value;
  const match = /(?:^|\s)(?:\/skill\s+lobster-workflows\s+|\/lwf\s+|lobster-workflows\s+)?(?:(lwf):)?(ap|rj):([a-f0-9]{12})(?:\s|$)/i.exec(normalized);
  if (!match) return null;
  return {
    action: match[2].toLowerCase() === 'ap' ? 'approve' : 'reject',
    callbackToken: match[3].toLowerCase(),
    normalized,
  };
}

function readOpenClawConfigFallback(env = process.env) {
  try {
    const openClawHome = resolveOpenClawHome(env);
    if (!openClawHome) return null;
    const configPath = path.join(openClawHome, 'openclaw.json');
    if (!fs.existsSync(configPath)) return null;
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

function splitCommaSeparatedList(value) {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function toStringList(value, options = {}) {
  const { splitComma = false } = options;
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return splitComma ? splitCommaSeparatedList(value) : [value.trim()];
  }
  return [];
}

function uniqueStrings(values) {
  const seen = new Set();
  const normalized = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    normalized.push(text);
  }
  return normalized;
}

function normalizeTelegramApproverId(value) {
  return String(value || '')
    .trim()
    .replace(/^(?:telegram|tg):/i, '')
    .trim();
}

function isTelegramUserId(value) {
  return /^\d+$/.test(String(value || '').trim());
}

function resolveTelegramApprovers({ workflow, env = process.env }) {
  const workflowApprovers = toStringList(workflow?.config?.approvals?.telegram?.approvers);
  if (workflowApprovers.length > 0) {
    return uniqueStrings(workflowApprovers.map(normalizeTelegramApproverId).filter(isTelegramUserId));
  }

  const envApprovers = toStringList(
    env.LOBSTER_WORKFLOWS_TELEGRAM_APPROVERS || env.OPENCLAW_TELEGRAM_APPROVERS || '',
    { splitComma: true },
  );
  if (envApprovers.length > 0) {
    return uniqueStrings(envApprovers.map(normalizeTelegramApproverId).filter(isTelegramUserId));
  }

  const config = readOpenClawConfigFallback(env) || {};
  const execApprovers = toStringList(config?.channels?.telegram?.execApprovals?.approvers);
  if (execApprovers.length > 0) {
    return uniqueStrings(execApprovers.map(normalizeTelegramApproverId).filter(isTelegramUserId));
  }

  const allowFrom = toStringList(config?.channels?.telegram?.allowFrom);
  if (allowFrom.length > 0) {
    return uniqueStrings(allowFrom.map(normalizeTelegramApproverId).filter(isTelegramUserId));
  }

  const defaultTo = toStringList(config?.channels?.telegram?.defaultTo);
  if (defaultTo.length > 0) {
    return uniqueStrings(defaultTo.map(normalizeTelegramApproverId).filter(isTelegramUserId));
  }

  return [];
}

function stringifyPreview(value, maxLength = 600) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function collapseWhitespace(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function truncateText(value, maxLength = 180) {
  const text = collapseWhitespace(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function humanizeKey(value) {
  const text = String(value ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!text) return 'Value';
  return text
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatContextValue(value, depth = 0) {
  if (value == null) return '';
  if (typeof value === 'string') return truncateText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (Array.isArray(value)) {
    const rendered = value
      .slice(0, 3)
      .map((entry) => formatContextValue(entry, depth + 1))
      .filter(Boolean);
    if (rendered.length === 0) return '';
    const suffix = value.length > 3 ? ` (+${value.length - 3} more)` : '';
    return `${rendered.join(', ')}${suffix}`;
  }

  if (typeof value === 'object') {
    const maxEntries = depth > 0 ? 3 : 4;
    const entries = Object.entries(value)
      .filter(([, entryValue]) => entryValue != null && String(entryValue).trim() !== '')
      .slice(0, maxEntries)
      .map(([key, entryValue]) => `${humanizeKey(key)}: ${formatContextValue(entryValue, depth + 1)}`)
      .filter((entry) => !entry.endsWith(': '));
    if (entries.length === 0) return '';
    const suffix = Object.keys(value).length > maxEntries ? ` | +${Object.keys(value).length - maxEntries} more` : '';
    return `${entries.join(' | ')}${suffix}`;
  }

  return truncateText(String(value));
}

function formatContextItems(items, maxItems = 3, maxLength = 180) {
  return (Array.isArray(items) ? items : [])
    .slice(0, maxItems)
    .map((item) => truncateText(formatContextValue(item), maxLength))
    .filter(Boolean);
}

function parseExecutionTimestamp(executionId) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(String(executionId || '').trim());
  if (!match) return null;

  const [, year, month, day, hour, minute, second, millisecond] = match;
  const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}.${millisecond}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatFriendlyRunLabel(executionId) {
  const parsed = parseExecutionTimestamp(executionId);
  if (!parsed) return escapeHtml(String(executionId || '').trim());

  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(parsed);

  return escapeHtml(`${formatted} UTC`);
}

function summarizeResolutionError(error) {
  if (!error) return null;
  const text = typeof error === 'string' ? error : error.message || JSON.stringify(error);
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  return lines.find((line) => !line.startsWith('at ')) || lines[0];
}

function buildTelegramApprovalMessage({
  workflow,
  executionId,
  trigger,
  scheduledFor,
  approval,
  envelope,
  pluginEnabled,
}) {
  const displayName = workflow.config.identity.displayName || workflow.workflowId;
  const lines = [
    '**⏳ Approval required**',
    '',
    `Workflow: ${escapeHtml(displayName)}`,
    `Run: ${formatFriendlyRunLabel(executionId)}`,
    `Trigger: ${escapeHtml(humanizeKey(trigger))}`,
  ];

  if (scheduledFor) {
    lines.push(`Scheduled: ${escapeHtml(scheduledFor)}`);
  }

  lines.push('');
  lines.push('Request');
  lines.push(escapeHtml(approval.prompt || 'Review this workflow and choose Approve or Reject.'));

  const contextItems = formatContextItems(approval.items);
  if (contextItems.length > 0) {
    lines.push('');
    lines.push('Context');
    for (const item of contextItems) {
      lines.push(`- ${escapeHtml(item)}`);
    }
    if (approval.items.length > 3) {
      lines.push(`- ...and ${approval.items.length - 3} more`);
    }
  } else {
    const previewItems = formatContextItems(envelope?.output);
    if (previewItems.length > 0) {
      lines.push('');
      lines.push('Preview');
      for (const item of previewItems) {
        lines.push(`- ${escapeHtml(item)}`);
      }
      if (Array.isArray(envelope?.output) && envelope.output.length > 3) {
        lines.push(`- ...and ${envelope.output.length - 3} more`);
      }
    }
  }

  lines.push('');
  if (pluginEnabled) {
    lines.push('Tap Approve or Reject below.');
  } else {
    lines.push('Inline approve/reject buttons require the optional lobster-workflows Telegram plugin.');
  }

  return lines.join('\n');
}

function buildTelegramButtons(callbackToken) {
  return [
    [
      { text: 'Approve', callback_data: `/lwf ap:${callbackToken}` },
      { text: 'Reject', callback_data: `/lwf rj:${callbackToken}` },
    ],
  ];
}

function isEnvTrue(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function isEnvFalse(value) {
  return ['0', 'false', 'no', 'off'].includes(String(value || '').trim().toLowerCase());
}

function isTelegramApprovalPluginEnabled(env = process.env) {
  if (Object.prototype.hasOwnProperty.call(env, 'LOBSTER_WORKFLOWS_TELEGRAM_PLUGIN_ENABLED')) {
    if (isEnvTrue(env.LOBSTER_WORKFLOWS_TELEGRAM_PLUGIN_ENABLED)) return true;
    if (isEnvFalse(env.LOBSTER_WORKFLOWS_TELEGRAM_PLUGIN_ENABLED)) return false;
  }

  const config = readOpenClawConfigFallback(env) || {};
  const entry = config?.plugins?.entries?.['lobster-workflows-telegram'];
  if (!entry || typeof entry !== 'object') return false;
  return entry.enabled !== false;
}

function parseJsonFromMixedStdout(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;

  for (let index = text.indexOf('{'); index >= 0; index = text.indexOf('{', index + 1)) {
    const candidate = text.slice(index);
    try {
      return JSON.parse(candidate);
    } catch {
      // keep searching for the start of the JSON payload
    }
  }

  return null;
}

function parseOpenClawMessageSendResult(stdout) {
  const parsed = parseJsonFromMixedStdout(stdout);
  const payload = parsed?.payload || parsed?.result?.payload || null;
  if (!payload) return null;
  return {
    ok: payload.ok === true,
    messageId: payload.messageId || null,
    chatId: payload.chatId || null,
  };
}

function getTelegramBotToken(env = process.env) {
  const config = readOpenClawConfigFallback(env) || {};
  return env.TELEGRAM_BOT_TOKEN || config?.channels?.telegram?.botToken || null;
}

function buildResolvedTelegramMessage({ workflow, executionId, decision, status, error }) {
  const displayName = workflow.config.identity.displayName || workflow.workflowId;
  const errorSummary = summarizeResolutionError(error);

  let heading = '<b>ℹ️ Approval resolved</b>';
  let decisionLabel = 'Resolved';
  let outcome = status || 'unknown';

  if (decision === 'reject' || status === 'cancelled') {
    heading = '<b>❌ Rejected</b>';
    decisionLabel = 'Rejected';
    outcome = 'Cancelled';
  } else if (status === 'success') {
    heading = '<b>✅ Approved</b>';
    decisionLabel = 'Approved';
    outcome = 'Completed successfully';
  } else if (status === 'failed') {
    heading = '<b>⚠️ Approval failed</b>';
    decisionLabel = decision === 'reject' ? 'Rejected' : 'Approved';
    outcome = 'Workflow failed after approval';
  }

  const lines = [
    heading,
    '',
    `Workflow: ${escapeHtml(displayName)}`,
    `Run: ${formatFriendlyRunLabel(executionId)}`,
    `Decision: ${escapeHtml(decisionLabel)}`,
    `Outcome: ${escapeHtml(outcome)}`,
  ];

  if (errorSummary) {
    lines.push('');
    lines.push(`Error: ${escapeHtml(errorSummary)}`);
  }

  return lines.join('\n');
}

async function settleTelegramApprovalNotification({
  workflow,
  executionId,
  decision,
  status = null,
  error = null,
  notification,
  env = process.env,
}) {
  if (!notification || notification.channel !== 'telegram') {
    return {
      ...notification,
      resolutionDeliveryStatus: 'skipped',
      resolutionError: 'Notification is not a Telegram message',
    };
  }

  if (!notification.chatId || !notification.messageId) {
    return {
      ...notification,
      resolutionDeliveryStatus: 'skipped',
      resolutionError: 'Missing Telegram chatId/messageId',
    };
  }

  const botToken = getTelegramBotToken(env);
  if (!botToken) {
    return {
      ...notification,
      resolutionDeliveryStatus: 'skipped',
      resolutionError: 'Missing Telegram bot token',
    };
  }

  const response = await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: notification.chatId,
      message_id: Number(notification.messageId),
      text: buildResolvedTelegramMessage({
        workflow,
        executionId,
        decision,
        status,
        error,
      }),
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [],
      },
    }),
  });

  const raw = await response.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  return {
    ...notification,
    resolutionDeliveryStatus: response.ok && parsed?.ok !== false ? 'edited' : 'failed',
    resolutionError: response.ok && parsed?.ok !== false ? null : (parsed?.description || raw || `${response.status} ${response.statusText}`),
    resolvedAt: new Date().toISOString(),
  };
}

function sendTelegramApprovalRequests({
  workflow,
  executionId,
  trigger,
  scheduledFor,
  approval,
  envelope,
  env = process.env,
}) {
  const pluginEnabled = isTelegramApprovalPluginEnabled(env);
  const approvers = Array.isArray(approval?.approvers) && approval.approvers.length > 0
    ? uniqueStrings(approval.approvers)
    : resolveTelegramApprovers({ workflow, env });
  if (approvers.length === 0) {
    return [{
      channel: 'telegram',
      deliveryStatus: 'skipped',
      target: null,
      sentAt: new Date().toISOString(),
      error: 'No Telegram approvers configured',
      callbackApprove: `/lwf ap:${approval.callbackToken}`,
      callbackReject: `/lwf rj:${approval.callbackToken}`,
    }];
  }

  const buttons = pluginEnabled ? buildTelegramButtons(approval.callbackToken) : null;
  const message = buildTelegramApprovalMessage({
    workflow,
    executionId,
    trigger,
    scheduledFor,
    approval,
    envelope,
    pluginEnabled,
  });

  return approvers.map((target) => {
    const args = [
      'message',
      'send',
      '--channel',
      'telegram',
      '--target',
      target,
      '--message',
      message,
      '--json',
    ];
    if (buttons) {
      args.push('--buttons', JSON.stringify(buttons));
    }
    const result = runCommand(env.LOBSTER_WORKFLOWS_OPENCLAW_BIN || 'openclaw', args, {
      env,
      timeoutMs: 30000,
    });
    const parsed = parseOpenClawMessageSendResult(result.stdout);
    const delivered = parsed?.ok === true;

    return {
      channel: 'telegram',
      target,
      sentAt: new Date().toISOString(),
      deliveryStatus: delivered ? 'sent' : 'failed',
      error: delivered ? null : (result.stderr || result.errorMessage || 'Telegram send failed'),
      chatId: parsed?.chatId || target,
      messageId: parsed?.messageId || null,
      callbackApprove: `/lwf ap:${approval.callbackToken}`,
      callbackReject: `/lwf rj:${approval.callbackToken}`,
    };
  });
}

module.exports = {
  buildTelegramApprovalMessage,
  buildResolvedTelegramMessage,
  createApprovalCallbackToken,
  getTelegramBotToken,
  isTelegramApprovalPluginEnabled,
  isApprovalEnvelope,
  isCancelledEnvelope,
  parseJsonFromMixedStdout,
  parseApprovalCallbackData,
  parseOpenClawMessageSendResult,
  resolveTelegramApprovers,
  settleTelegramApprovalNotification,
  sendTelegramApprovalRequests,
};
