const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PLUGIN_ID,
  isMissingConfigPath,
  mergePluginAllowlist,
  parsePluginsAllowJson,
} = require('../scripts/install-telegram-plugin');

test('install helper parses existing plugins.allow arrays', () => {
  assert.deepEqual(parsePluginsAllowJson('["alpha","beta"]'), ['alpha', 'beta']);
  assert.deepEqual(parsePluginsAllowJson(''), []);
});

test('install helper rejects non-array plugins.allow values', () => {
  assert.throws(
    () => parsePluginsAllowJson('"alpha"'),
    /Expected plugins\.allow to be a JSON array\./u,
  );
});

test('install helper merges the telegram plugin without dropping existing entries', () => {
  assert.deepEqual(
    mergePluginAllowlist(['alpha', 'beta']),
    ['alpha', 'beta', PLUGIN_ID],
  );
  assert.deepEqual(
    mergePluginAllowlist(['alpha', PLUGIN_ID]),
    ['alpha', PLUGIN_ID],
  );
});

test('install helper detects missing config paths from CLI output', () => {
  assert.equal(isMissingConfigPath({
    stdout: 'Config path not found: plugins.allow',
    stderr: '',
  }), true);
  assert.equal(isMissingConfigPath({
    stdout: '',
    stderr: 'some other error',
  }), false);
});
