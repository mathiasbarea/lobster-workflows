const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadAgentTurnTemplate() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lobster-agent-turn-'));
  const templatePath = path.join(__dirname, '..', 'templates', 'shared', 'agent-turn.js');
  const targetPath = path.join(tempRoot, 'agent-turn.js');
  fs.copyFileSync(templatePath, targetPath);
  fs.writeFileSync(path.join(tempRoot, 'process-runner.js'), 'module.exports = { runCommand() { throw new Error("runCommand should not be called in this test."); } };\n', 'utf8');
  return require(targetPath);
}

const {
  collectPayloadText,
  parseJsonFromMixedText,
  runAgentTurn,
  stripCodeFences,
} = loadAgentTurnTemplate();

test('parseJsonFromMixedText finds the first valid JSON object in mixed output', () => {
  const parsed = parseJsonFromMixedText('info: starting\n{"ok":true,"count":2}');
  assert.deepEqual(parsed, { ok: true, count: 2 });
});

test('stripCodeFences removes fenced wrappers before payload parsing', () => {
  assert.equal(stripCodeFences('```json\n{"ok":true}\n```'), '{"ok":true}');
});

test('collectPayloadText joins text payloads in order', () => {
  const payloadText = collectPayloadText({
    payloads: [
      { text: 'first' },
      { text: '' },
      { text: 'second' },
    ],
  });

  assert.equal(payloadText, 'first\nsecond');
});

test('runAgentTurn builds a CLI invocation and parses a structured payload', async () => {
  const calls = [];
  const result = await runAgentTurn({
    agentId: 'coding',
    workspaceRoot: 'C:/tmp/workspace-coding',
    message: 'Build the MVP',
    sessionId: 'project-alpha',
    timeoutSeconds: 45,
    thinking: 'high',
    extraArgs: ['--approval', 'never'],
    runCommandFn(command, args, options) {
      calls.push({ command, args, options });
      return {
        ok: true,
        stdout: 'log line\n{"payloads":[{"text":"```json\\n{\\"status\\":\\"done\\",\\"ok\\":true}\\n```"}]}',
        stderr: '',
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'openclaw');
  assert.deepEqual(calls[0].args, [
    'agent',
    '--agent',
    'coding',
    '--local',
    '--json',
    '--message',
    'Build the MVP',
    '--timeout',
    '45',
    '--session-id',
    'project-alpha',
    '--thinking',
    'high',
    '--approval',
    'never',
  ]);
  assert.equal(calls[0].options.cwd, 'C:/tmp/workspace-coding');
  assert.equal(calls[0].options.timeoutMs, 55000);
  assert.equal(result.payloadText, '```json\n{"status":"done","ok":true}\n```');
  assert.deepEqual(result.parsedPayload, { status: 'done', ok: true });
});

test('runAgentTurn rejects failed command executions', async () => {
  await assert.rejects(() => runAgentTurn({
    agentId: 'research',
    message: 'Inspect this source',
    runCommandFn() {
      return {
        ok: false,
        stderr: 'permission denied',
      };
    },
  }), /permission denied/);
});
