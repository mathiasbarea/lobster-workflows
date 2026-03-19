import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMAND_NAME = 'lwf';
const DEFAULT_TIMEOUT_MS = 30000;

function resolvePluginRoot() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function resolveOpenClawHome() {
  const explicitHome = String(process.env.OPENCLAW_HOME || process.env.CODEX_HOME || '').trim();
  if (explicitHome) return explicitHome;

  const userHome = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (!userHome) return null;
  return path.join(userHome, '.openclaw');
}

function isExistingDir(dirPath) {
  return Boolean(dirPath && existsSync(dirPath));
}

function isSkillRoot(dirPath) {
  return Boolean(
    dirPath
    && existsSync(path.join(dirPath, 'SKILL.md'))
    && existsSync(path.join(dirPath, 'scripts', 'resume-workflow.js'))
  );
}

function isWorkspaceRoot(dirPath) {
  return Boolean(
    dirPath
    && existsSync(dirPath)
    && existsSync(path.join(dirPath, 'workflows'))
  );
}

function deriveSkillRootFromWorkspaceRoot(workspaceRoot) {
  if (!workspaceRoot) return null;
  const normalizedWorkspaceRoot = path.resolve(workspaceRoot);
  if (path.basename(normalizedWorkspaceRoot).toLowerCase() === 'workspace') {
    return path.join(path.dirname(normalizedWorkspaceRoot), 'skills', 'lobster-workflows');
  }
  return path.join(normalizedWorkspaceRoot, 'skills', 'lobster-workflows');
}

function deriveWorkspaceRootsFromSkillRoot(skillRoot) {
  if (!skillRoot) return [];

  const skillParent = path.dirname(skillRoot);
  if (path.basename(skillParent).toLowerCase() !== 'skills') return [];

  const openClawHome = path.dirname(skillParent);
  return [
    path.join(openClawHome, 'workspace'),
    openClawHome,
  ];
}

export function parseApprovalArgs(rawArgs = '') {
  const value = String(rawArgs || '').trim();
  if (!value) return null;

  let match = /^(ap|rj):([a-f0-9]{12})$/i.exec(value);
  if (match) {
    return {
      shortAction: match[1].toLowerCase(),
      decision: match[1].toLowerCase() === 'ap' ? 'approve' : 'reject',
      callbackToken: match[2].toLowerCase(),
    };
  }

  match = /^(approve|reject)\s+([a-f0-9]{12})$/i.exec(value);
  if (match) {
    return {
      shortAction: match[1].toLowerCase() === 'approve' ? 'ap' : 'rj',
      decision: match[1].toLowerCase(),
      callbackToken: match[2].toLowerCase(),
    };
  }

  return null;
}

export function resolveSkillRoot(api) {
  const pluginRoot = resolvePluginRoot();
  const configuredSkillRoot = api?.pluginConfig?.skillRoot;
  const workspaceRoot = api?.config?.agents?.defaults?.workspace;
  const openClawHome = resolveOpenClawHome();

  const candidates = [
    configuredSkillRoot,
    path.resolve(pluginRoot, '..'),
    deriveSkillRootFromWorkspaceRoot(workspaceRoot),
    openClawHome ? path.join(openClawHome, 'skills', 'lobster-workflows') : null,
  ];

  return candidates.find(isSkillRoot) || null;
}

export function resolveWorkspaceRoot(api, skillRoot = null) {
  const configuredWorkspaceRoot = api?.pluginConfig?.workspaceRoot;
  const defaultWorkspaceRoot = api?.config?.agents?.defaults?.workspace;
  const openClawHome = resolveOpenClawHome();

  if (isWorkspaceRoot(configuredWorkspaceRoot)) return configuredWorkspaceRoot;
  if (isWorkspaceRoot(defaultWorkspaceRoot)) return defaultWorkspaceRoot;

  const discoveredWorkspaceRoot = [
    ...deriveWorkspaceRootsFromSkillRoot(skillRoot),
    openClawHome ? path.join(openClawHome, 'workspace') : null,
    openClawHome,
  ].find(isWorkspaceRoot);
  if (discoveredWorkspaceRoot) return discoveredWorkspaceRoot;

  return null;
}

function formatUsage() {
  return [
    'Lobster workflows approval commands:',
    '',
    '/lwf ap:<token>',
    '/lwf rj:<token>',
    '',
    'Examples:',
    '/lwf ap:abcdef123456',
    '/lwf reject abcdef123456',
  ].join('\n');
}

function summarizeErrorText(value, fallback = 'lobster-workflows approval failed.') {
  const text = String(value || '').trim();
  if (!text) return fallback;

  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return fallback;

  const firstMeaningfulLine = lines.find((line) => !line.startsWith('at ')) || lines[0];
  return firstMeaningfulLine || fallback;
}

function buildSuccessText(payload) {
  const workflowLabel = payload?.workflowId || 'workflow';
  const executionLabel = payload?.executionId || 'unknown execution';

  if (payload?.decision === 'reject' || payload?.status === 'cancelled') {
    return `Rejected ${workflowLabel} (${executionLabel}).`;
  }
  if (payload?.status === 'success') {
    return `Approved ${workflowLabel} (${executionLabel}).`;
  }
  if (payload?.status === 'failed' && payload?.error?.message) {
    return `Approval failed for ${workflowLabel} (${executionLabel}): ${summarizeErrorText(payload.error.message, 'workflow execution failed.')}`;
  }
  return `Resolved ${workflowLabel} (${executionLabel}) with status ${payload?.status || 'unknown'}.`;
}

function buildErrorText(stderr, stdout, fallback) {
  const text = String(stderr || stdout || fallback || '').trim();
  if (!text) return 'lobster-workflows approval failed.';
  return summarizeErrorText(text, fallback);
}

function buildSilentReplyMetadata(payload) {
  const approvalId = String(payload?.executionId || '').trim() || `lwf-${Date.now()}`;
  const approvalSlug = String(payload?.workflowId || '').trim() || 'lobster-workflows';
  return {
    execApproval: {
      approvalId,
      approvalSlug,
    },
  };
}

function shouldSuppressReply(payload) {
  return Number(payload?.editedNotificationCount || 0) > 0;
}

export function createCommandHandler(api) {
  return async function handleLwfCommand(ctx) {
    if (ctx.channel !== 'telegram') {
      return { text: 'The /lwf command is only available from Telegram inline approvals.' };
    }

    const parsed = parseApprovalArgs(ctx.args || '');
    if (!parsed) {
      return { text: formatUsage() };
    }

    const skillRoot = resolveSkillRoot(api);
    if (!skillRoot) {
      return {
        text: 'lobster-workflows skill root not found. Install the skill first or set plugins.entries.lobster-workflows-telegram.config.skillRoot.',
      };
    }

    const workspaceRoot = resolveWorkspaceRoot(api, skillRoot);
    if (!workspaceRoot) {
      return {
        text: 'Workspace root not found. Set plugins.entries.lobster-workflows-telegram.config.workspaceRoot or configure agents.defaults.workspace.',
      };
    }

    const resumeScriptPath = path.join(skillRoot, 'scripts', 'resume-workflow.js');
    if (!existsSync(resumeScriptPath)) {
      return { text: 'lobster-workflows resume script not found.' };
    }

    const callbackData = `lwf:${parsed.shortAction}:${parsed.callbackToken}`;
    const args = [
      resumeScriptPath,
      '--workspace-root',
      workspaceRoot,
      '--callback-data',
      callbackData,
    ];
    if (ctx.senderId) {
      args.push('--sender-id', String(ctx.senderId));
    }

    const result = spawnSync(process.execPath, args, {
      cwd: skillRoot,
      env: process.env,
      encoding: 'utf8',
      timeout: DEFAULT_TIMEOUT_MS,
    });

    if (result.error) {
      return { text: `lobster-workflows approval failed: ${result.error.message}` };
    }
    if (result.status !== 0) {
      return {
        text: buildErrorText(result.stderr, result.stdout, 'lobster-workflows approval failed.'),
      };
    }

    let payload = null;
    try {
      payload = JSON.parse(result.stdout || '{}');
    } catch {
      return { text: buildErrorText(result.stderr, result.stdout, 'lobster-workflows approval returned invalid JSON.') };
    }

    if (shouldSuppressReply(payload)) {
      return {
        text: 'NO_REPLY',
        channelData: buildSilentReplyMetadata(payload),
      };
    }

    return { text: buildSuccessText(payload) };
  };
}

export default function register(api) {
  api.registerCommand({
    name: COMMAND_NAME,
    description: 'Approve or reject pending lobster-workflows Telegram approvals.',
    acceptsArgs: true,
    handler: createCommandHandler(api),
  });
}
