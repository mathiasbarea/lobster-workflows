const { spawnSync } = require('child_process');

function runCommand(command, args = [], options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: 'pipe',
    input: options.stdinText || '',
    shell: options.shell || false,
    maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
    timeout: options.timeoutMs,
    killSignal: options.killSignal || 'SIGTERM',
  });

  return {
    ok: result.status === 0 && !result.error,
    command,
    args,
    cwd: options.cwd || process.cwd(),
    exitCode: result.status,
    signal: result.signal || null,
    durationMs: Date.now() - startedAt,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    errorMessage: result.error ? String(result.error.message || result.error) : null,
    timedOut: Boolean(
      (options.timeoutMs && result.error && /timed out|ETIMEDOUT/i.test(String(result.error.message || result.error))) ||
      result.signal === 'SIGTERM'
    ),
  };
}

module.exports = {
  runCommand,
};
