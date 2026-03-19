const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const resolvedWindowsCliCache = new Map();

function quoteWindowsArg(value) {
  const text = String(value);
  if (!text) return '""';
  if (!/[\s"]/u.test(text)) return text;
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function parseNodeScriptFromCmdWrapper(commandPath) {
  if (!fs.existsSync(commandPath)) return null;
  const content = fs.readFileSync(commandPath, 'utf8');
  const match = content.match(/"%dp0%\\([^"]+\.(?:mjs|js))"/i);
  if (!match) return null;
  const relativeScriptPath = match[1].replace(/\\/g, path.sep);
  const scriptPath = path.join(path.dirname(commandPath), relativeScriptPath);
  return fs.existsSync(scriptPath) ? scriptPath : null;
}

function resolveWindowsCliCommand(command, env) {
  const cacheKey = `${command}::${env.Path || env.PATH || ''}`;
  if (resolvedWindowsCliCache.has(cacheKey)) {
    return resolvedWindowsCliCache.get(cacheKey);
  }

  let commandPath = command;
  if (!path.isAbsolute(commandPath) || !fs.existsSync(commandPath)) {
    const lookupTarget = commandPath.toLowerCase().endsWith('.cmd') ? commandPath : `${commandPath}.cmd`;
    const whereResult = spawnSync('where.exe', [lookupTarget], {
      encoding: 'utf8',
      stdio: 'pipe',
      env,
      timeout: 10000,
    });
    if (whereResult.status === 0 && whereResult.stdout) {
      const candidate = whereResult.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean);
      if (candidate) {
        commandPath = candidate;
      }
    }
  }

  const scriptPath = commandPath.toLowerCase().endsWith('.cmd') ? parseNodeScriptFromCmdWrapper(commandPath) : null;
  const resolved = scriptPath
    ? { command: process.execPath, argsPrefix: [scriptPath] }
    : { command: process.env.ComSpec || 'cmd.exe', argsPrefix: ['/d', '/s', '/c', quoteWindowsArg(commandPath)] };
  resolvedWindowsCliCache.set(cacheKey, resolved);
  return resolved;
}

function prepareInvocation(command, args, options = {}) {
  if (process.platform !== 'win32' || options.shell) {
    return {
      command,
      args,
      shell: options.shell || false,
    };
  }

  const lowerCommand = String(command).toLowerCase();
  const looksLikeWindowsWrapper = lowerCommand === 'openclaw' ||
    lowerCommand === 'lobster' ||
    lowerCommand.endsWith('.cmd');

  if (!looksLikeWindowsWrapper) {
    return {
      command,
      args,
      shell: false,
    };
  }

  const resolved = resolveWindowsCliCommand(command, options.env || process.env);
  if (resolved.command === process.execPath) {
    return {
      command: process.execPath,
      args: [...resolved.argsPrefix, ...args],
      shell: false,
    };
  }

  return {
    command: resolved.command,
    args: [...resolved.argsPrefix.slice(0, -1), `${resolved.argsPrefix.at(-1)} ${args.map(quoteWindowsArg).join(' ')}`],
    shell: false,
  };
}

function runCommand(command, args = [], options = {}) {
  const invocation = prepareInvocation(command, args, options);
  const startedAt = Date.now();
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: 'pipe',
    input: options.stdinText || '',
    shell: invocation.shell,
    maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
    timeout: options.timeoutMs,
    killSignal: options.killSignal || 'SIGTERM',
  });

  return {
    ok: result.status === 0 && !result.error,
    command: invocation.command,
    args: invocation.args,
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
