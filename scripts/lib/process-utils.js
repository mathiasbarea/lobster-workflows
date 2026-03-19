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
  const scriptMatches = content.matchAll(/"(%~?dp0%?\\[^"]+\.(?:mjs|js))"/ig);
  for (const match of scriptMatches) {
    const relativeScriptPath = match[1]
      .replace(/^%~?dp0%?\\/i, '')
      .replace(/\\/g, path.sep);
    const scriptPath = path.join(path.dirname(commandPath), relativeScriptPath);
    if (fs.existsSync(scriptPath)) {
      return scriptPath;
    }
  }
  return null;
}

function resolveWindowsCliCommand(command, env) {
  const cacheKey = `${command}::${env.Path || env.PATH || ''}`;
  if (resolvedWindowsCliCache.has(cacheKey)) {
    return resolvedWindowsCliCache.get(cacheKey);
  }

  let commandPath = command;
  let resolvedViaWhere = false;
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
        resolvedViaWhere = true;
      }
    }
  }

  const isCmdWrapper = String(commandPath).toLowerCase().endsWith('.cmd');
  const scriptPath = isCmdWrapper ? parseNodeScriptFromCmdWrapper(commandPath) : null;
  const resolved = scriptPath
    ? {
      command: process.execPath,
      argsPrefix: [scriptPath],
      resolutionMode: resolvedViaWhere ? 'where-openclaw-cmd' : 'explicit-windows-cmd',
      cliCmdPath: commandPath,
      cliScriptPath: scriptPath,
    }
    : {
      command: process.env.ComSpec || 'cmd.exe',
      argsPrefix: ['/d', '/s', '/c', quoteWindowsArg(commandPath)],
      resolutionMode: isCmdWrapper
        ? (resolvedViaWhere ? 'where-openclaw-cmd-shell' : 'explicit-windows-cmd-shell')
        : 'windows-shell-command',
      cliCmdPath: isCmdWrapper ? commandPath : null,
      cliScriptPath: null,
    };
  resolvedWindowsCliCache.set(cacheKey, resolved);
  return resolved;
}

function prepareInvocation(command, args, options = {}) {
  if (process.platform !== 'win32' || options.shell) {
    return {
      command,
      args,
      shell: options.shell || false,
      diagnostics: {
        platform: process.platform,
        shell: options.shell || false,
        requestedCommand: command,
        resolutionMode: 'direct',
      },
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
      diagnostics: {
        platform: process.platform,
        shell: false,
        requestedCommand: command,
        resolutionMode: 'direct',
      },
    };
  }

  const resolved = resolveWindowsCliCommand(command, options.env || process.env);
  if (resolved.command === process.execPath) {
    return {
      command: process.execPath,
      args: [...resolved.argsPrefix, ...args],
      shell: false,
      diagnostics: {
        platform: process.platform,
        shell: false,
        requestedCommand: command,
        resolutionMode: resolved.resolutionMode,
        cliCmdPath: resolved.cliCmdPath,
        cliScriptPath: resolved.cliScriptPath,
      },
    };
  }

  return {
    command: resolved.command,
    args: [...resolved.argsPrefix.slice(0, -1), `${resolved.argsPrefix.at(-1)} ${args.map(quoteWindowsArg).join(' ')}`],
    shell: false,
    diagnostics: {
      platform: process.platform,
      shell: false,
      requestedCommand: command,
      resolutionMode: resolved.resolutionMode,
      cliCmdPath: resolved.cliCmdPath,
      cliScriptPath: resolved.cliScriptPath,
    },
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
    invocation: invocation.diagnostics,
    timedOut: Boolean(
      (options.timeoutMs && result.error && /timed out|ETIMEDOUT/i.test(String(result.error.message || result.error))) ||
      result.signal === 'SIGTERM'
    ),
  };
}

module.exports = {
  prepareInvocation,
  runCommand,
};
