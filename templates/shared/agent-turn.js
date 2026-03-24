const fs = require('fs');
const path = require('path');

const { runCommand } = require('./process-runner');

function quoteForCmd(part) {
  const text = String(part);
  if (!/[\s"]/u.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function runOpenClawCommand(command, args, options) {
  const normalized = String(command || '').trim().toLowerCase();
  if (normalized.endsWith('.cmd') || normalized.endsWith('.bat')) {
    const openclawScriptPath = path.join(path.dirname(command), 'node_modules', 'openclaw', 'openclaw.mjs');
    if (fs.existsSync(openclawScriptPath)) {
      return runCommand(process.execPath, [openclawScriptPath, ...args], options);
    }
  }

  if (!normalized.endsWith('.cmd') && !normalized.endsWith('.bat')) {
    return runCommand(command, args, options);
  }

  const invocation = `${command} ${args.map((part) => quoteForCmd(part)).join(' ')}`.trim();
  return runCommand(process.env.ComSpec || 'cmd.exe', ['/d', '/c', invocation], options);
}

function parseJsonFromMixedText(text) {
  const input = String(text || '').trim();
  if (!input) return null;

  const startIndexes = [];
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '{' || char === '[') startIndexes.push(index);
  }

  for (const index of startIndexes) {
    try {
      return JSON.parse(input.slice(index));
    } catch {
      // Keep scanning until a valid JSON payload is found.
    }
  }

  return null;
}

function stripCodeFences(text) {
  const trimmed = String(text || '').trim();
  const match = trimmed.match(/^```(?:[\w-]+)?\s*([\s\S]*?)\s*```$/u);
  return match ? String(match[1] || '').trim() : trimmed;
}

function collectPayloadText(response) {
  return (Array.isArray(response?.payloads) ? response.payloads : [])
    .map((payload) => String(payload?.text || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function normalizeExtraArgs(extraArgs) {
  if (!Array.isArray(extraArgs)) {
    throw new Error('runAgentTurn extraArgs must be an array when provided.');
  }
  return extraArgs.map((value) => String(value));
}

async function runAgentTurn({
  agentId,
  workspaceRoot,
  message,
  sessionId,
  timeoutSeconds = 600,
  openclawCommand = 'openclaw',
  thinking = 'medium',
  extraArgs = [],
  runCommandFn = runOpenClawCommand,
}) {
  const normalizedAgentId = String(agentId || '').trim();
  const normalizedMessage = String(message || '').trim();
  if (!normalizedAgentId) {
    throw new Error('runAgentTurn requires a non-empty agentId.');
  }
  if (!normalizedMessage) {
    throw new Error('runAgentTurn requires a non-empty message.');
  }

  const args = [
    'agent',
    '--agent',
    normalizedAgentId,
    '--local',
    '--json',
    '--message',
    normalizedMessage,
    '--timeout',
    String(timeoutSeconds),
  ];

  if (sessionId) {
    args.push('--session-id', String(sessionId));
  }

  if (thinking) {
    args.push('--thinking', String(thinking));
  }

  args.push(...normalizeExtraArgs(extraArgs));

  const commandResult = await Promise.resolve(runCommandFn(openclawCommand, args, {
    cwd: workspaceRoot || process.cwd(),
    timeoutMs: Math.max(30000, timeoutSeconds * 1000 + 10000),
  }));

  if (!commandResult?.ok) {
    throw new Error(`OpenClaw agent command failed for "${normalizedAgentId}": ${commandResult?.stderr || commandResult?.stdout || commandResult?.errorMessage || 'unknown error'}`);
  }

  const rawResponse = parseJsonFromMixedText(commandResult.stdout);
  if (!rawResponse) {
    throw new Error(`OpenClaw agent command for "${normalizedAgentId}" did not return valid JSON output.`);
  }

  const payloadText = collectPayloadText(rawResponse);
  const parsedPayload = parseJsonFromMixedText(stripCodeFences(payloadText));

  return {
    rawResponse,
    payloadText,
    parsedPayload,
    commandResult,
  };
}

module.exports = {
  collectPayloadText,
  parseJsonFromMixedText,
  runAgentTurn,
  runOpenClawCommand,
  stripCodeFences,
};
