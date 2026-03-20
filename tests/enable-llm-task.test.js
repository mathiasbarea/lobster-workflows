const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  DEFAULT_AGENT_ID,
  LLM_TASK_PLUGIN_ID,
  enableLlmTask,
  mergeAgentToolAllowlist,
  mergeStringAllowlist,
  parseAgentsListJson,
} = require('../scripts/enable-llm-task');

test('enable-llm-task parses agents.list arrays', () => {
  assert.deepEqual(parseAgentsListJson('[{"id":"main"}]'), [{ id: 'main' }]);
  assert.deepEqual(parseAgentsListJson(''), []);
});

test('enable-llm-task rejects non-array agents.list values', () => {
  assert.throws(
    () => parseAgentsListJson('{"id":"main"}'),
    /Expected agents\.list to be a JSON array\./u,
  );
});

test('enable-llm-task merges string allowlists without dropping existing entries', () => {
  assert.deepEqual(
    mergeStringAllowlist(['alpha', 'beta'], LLM_TASK_PLUGIN_ID),
    ['alpha', 'beta', LLM_TASK_PLUGIN_ID],
  );
  assert.deepEqual(
    mergeStringAllowlist(['alpha', LLM_TASK_PLUGIN_ID], LLM_TASK_PLUGIN_ID),
    ['alpha', LLM_TASK_PLUGIN_ID],
  );
});

test('enable-llm-task adds a main agent entry when agents.list is missing', () => {
  assert.deepEqual(
    mergeAgentToolAllowlist([], {}),
    [{
      id: DEFAULT_AGENT_ID,
      tools: {
        allow: [LLM_TASK_PLUGIN_ID],
      },
    }],
  );
});

test('enable-llm-task merges llm-task into an existing main agent tool allowlist', () => {
  assert.deepEqual(
    mergeAgentToolAllowlist([
      {
        id: 'main',
        tools: {
          allow: ['browser'],
          deny: ['exec'],
        },
      },
      {
        id: 'support',
        tools: {
          allow: ['sessions_list'],
        },
      },
    ]),
    [
      {
        id: 'main',
        tools: {
          allow: ['browser', LLM_TASK_PLUGIN_ID],
          deny: ['exec'],
        },
      },
      {
        id: 'support',
        tools: {
          allow: ['sessions_list'],
        },
      },
    ],
  );
});

test('enable-llm-task leaves plugins.allow unset when the config path is missing', () => {
  const calls = [];
  const result = enableLlmTask({
    skillRoot: path.resolve(__dirname, '..'),
    runCommandFn: (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === 'config' && args[1] === 'set' && args[2] === 'plugins.entries.llm-task.enabled') {
        return { ok: true, stdout: '', stderr: '', command, args };
      }
      if (args[0] === 'config' && args[1] === 'get' && args[2] === 'plugins.allow') {
        return {
          ok: false,
          stdout: 'Config path not found: plugins.allow',
          stderr: '',
          command,
          args,
        };
      }
      if (args[0] === 'config' && args[1] === 'get' && args[2] === 'agents.list') {
        return {
          ok: false,
          stdout: 'Config path not found: agents.list',
          stderr: '',
          command,
          args,
        };
      }
      if (args[0] === 'config' && args[1] === 'set' && args[2] === 'agents.list') {
        return { ok: true, stdout: '', stderr: '', command, args };
      }
      throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
    },
  });

  assert.equal(result.pluginsAllowPresent, false);
  assert.equal(result.pluginsAllow, null);
  assert.equal(
    calls.some((call) => call[0] === 'openclaw' && call[1] === 'config' && call[2] === 'set' && call[3] === 'plugins.allow'),
    false,
  );
});
