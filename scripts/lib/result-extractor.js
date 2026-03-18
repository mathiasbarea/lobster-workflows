function getValueAtPath(target, pathText) {
  if (!pathText) return target;
  return String(pathText)
    .split('.')
    .filter(Boolean)
    .reduce((value, key) => (value == null ? undefined : value[key]), target);
}

function isSubsetMatch(target, expectation) {
  if (expectation === null || typeof expectation !== 'object' || Array.isArray(expectation)) {
    return Object.is(target, expectation);
  }
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    return false;
  }

  return Object.entries(expectation).every(([key, expectedValue]) => isSubsetMatch(target[key], expectedValue));
}

function extractWorkflowResult({ config, envelope }) {
  const extractor = config.result?.extractor || {};
  if (extractor.sourceAction && envelope && envelope.action !== extractor.sourceAction) {
    throw new Error(`Workflow result extractor expected action ${extractor.sourceAction} but received ${envelope && envelope.action}`);
  }

  const root = Object.prototype.hasOwnProperty.call(envelope || {}, 'data') ? envelope.data : envelope;
  return getValueAtPath(root, extractor.dataPath || null);
}

function isSuccessfulEnvelope({ config, envelope, processResult }) {
  if (!processResult.ok) return false;
  const successCondition = config.observability?.successCondition;
  if (!successCondition) return true;
  return isSubsetMatch(envelope, successCondition);
}

module.exports = {
  extractWorkflowResult,
  getValueAtPath,
  isSuccessfulEnvelope,
};
