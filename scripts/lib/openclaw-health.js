const { parseJsonFromMixedStdout } = require('./approval-utils');
const { runCommand } = require('./process-utils');

function describeCommandFailure(step, result) {
  const stderr = String(result?.stderr || '').trim();
  const stdout = String(result?.stdout || '').trim();
  const details = stderr || stdout || result?.errorMessage || 'Unknown error';
  return `${step} failed: ${details}`;
}

function parseJsonCommandOutput(step, result) {
  if (!result?.ok) {
    throw new Error(describeCommandFailure(step, result));
  }

  const parsed = parseJsonFromMixedStdout(result.stdout);
  if (!parsed) {
    throw new Error(`${step} did not return valid JSON output.`);
  }

  return parsed;
}

function loadGatewayStatus({
  cwd,
  env = process.env,
  run = runCommand,
  openclawCommand = env.LOBSTER_WORKFLOWS_OPENCLAW_BIN || 'openclaw',
  timeoutMs = 10000,
} = {}) {
  const result = run(openclawCommand, ['gateway', 'status', '--json', '--timeout', String(timeoutMs)], {
    cwd,
    env,
    timeoutMs,
  });
  return parseJsonCommandOutput('openclaw gateway status', result);
}

function loadOpenclawStatus({
  cwd,
  env = process.env,
  run = runCommand,
  openclawCommand = env.LOBSTER_WORKFLOWS_OPENCLAW_BIN || 'openclaw',
  timeoutMs = 10000,
} = {}) {
  const result = run(openclawCommand, ['status', '--json', '--timeout', String(timeoutMs)], {
    cwd,
    env,
    timeoutMs,
  });
  return parseJsonCommandOutput('openclaw status', result);
}

function collectGatewayAccessDiagnostics(options = {}) {
  let gatewayStatus = null;
  let gatewayStatusError = null;
  try {
    gatewayStatus = loadGatewayStatus(options);
  } catch (error) {
    gatewayStatusError = error.message || String(error);
  }

  let openclawStatus = null;
  let openclawStatusError = null;
  try {
    openclawStatus = loadOpenclawStatus(options);
  } catch (error) {
    openclawStatusError = error.message || String(error);
  }

  return {
    gatewayStatus,
    gatewayStatusError,
    openclawStatus,
    openclawStatusError,
  };
}

function resolveGatewayListeningAddress(gatewayStatus) {
  const listenerAddress = gatewayStatus?.port?.listeners?.find((listener) => listener?.address)?.address;
  if (listenerAddress) return listenerAddress;

  const bindHost = gatewayStatus?.gateway?.bindHost;
  const port = gatewayStatus?.gateway?.port;
  if (bindHost && port) return `${bindHost}:${port}`;
  return null;
}

function summarizeGatewayAccessDiagnostics(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') return '';

  const parts = [];
  const gatewayStatus = diagnostics.gatewayStatus;
  const gatewayStatusError = diagnostics.gatewayStatusError;
  const openclawStatus = diagnostics.openclawStatus;
  const openclawStatusError = diagnostics.openclawStatusError;

  if (gatewayStatus?.rpc?.ok === true) {
    const address = resolveGatewayListeningAddress(gatewayStatus);
    const rpcUrl = gatewayStatus?.rpc?.url || gatewayStatus?.gateway?.probeUrl || null;
    if (address && rpcUrl) {
      parts.push(`gateway RPC ok (${rpcUrl}; listening ${address})`);
    } else if (address) {
      parts.push(`gateway RPC ok (listening ${address})`);
    } else if (rpcUrl) {
      parts.push(`gateway RPC ok (${rpcUrl})`);
    } else {
      parts.push('gateway RPC ok');
    }
  } else if (gatewayStatusError) {
    parts.push(`gateway RPC status unavailable (${gatewayStatusError})`);
  } else if (gatewayStatus?.rpc?.ok === false) {
    const rpcUrl = gatewayStatus?.rpc?.url || gatewayStatus?.gateway?.probeUrl || 'unknown url';
    parts.push(`gateway RPC probe failed (${rpcUrl})`);
  }

  const gateway = openclawStatus?.gateway;
  if (gateway?.reachable === true) {
    parts.push('operator-level gateway status readable');
  } else if (gateway?.error) {
    if (/missing scope:\s*operator\.read/i.test(String(gateway.error))) {
      parts.push(`operator-level status unavailable (${gateway.error})`);
    } else {
      parts.push(`operator-level gateway status unreachable (${gateway.error})`);
    }
  } else if (openclawStatusError) {
    parts.push(`operator-level status check failed (${openclawStatusError})`);
  }

  return parts.length > 0 ? `Gateway diagnostics: ${parts.join('; ')}` : '';
}

module.exports = {
  collectGatewayAccessDiagnostics,
  describeCommandFailure,
  loadGatewayStatus,
  loadOpenclawStatus,
  parseJsonCommandOutput,
  resolveGatewayListeningAddress,
  summarizeGatewayAccessDiagnostics,
};
