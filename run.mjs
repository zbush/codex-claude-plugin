import { spawn } from 'node:child_process';
import { delimiter, dirname, join } from 'node:path';
import { accessSync, constants, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isFullyAbsolute } from './workspace-policy.mjs';

// Windows npm distributions may expose only a .cmd shim. Run the official
// package entry with Node so prompts and arguments never go through cmd.exe.
const windows = process.platform === 'win32';

function directories(root, pattern) {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && pattern.test(entry.name))
      .map(entry => entry.name)
      .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  } catch { return []; }
}

function* claudeBundles(home, env, binary) {
  const bundles = [];
  for (const base of [env.APPDATA, env.LOCALAPPDATA, env.XDG_CONFIG_HOME].filter(isFullyAbsolute)) {
    bundles.push(join(base, 'Claude', 'claude-code'));
  }
  if (isFullyAbsolute(home)) {
    bundles.push(join(home, 'Library', 'Application Support', 'Claude', 'claude-code'),
      join(home, '.config', 'Claude', 'claude-code'));
  }
  if (windows && isFullyAbsolute(env.LOCALAPPDATA)) {
    const packages = join(env.LOCALAPPDATA, 'Packages');
    for (const name of directories(packages, /^Claude_/i)) {
      bundles.push(join(packages, name, 'LocalCache', 'Roaming', 'Claude', 'claude-code'));
    }
  }
  for (const root of bundles) {
    yield join(root, binary);
    for (const version of directories(root, /^\d/)) {
      const versionDir = join(root, version);
      yield join(versionDir, binary);
      for (const sub of directories(versionDir, /^/)) yield join(versionDir, sub, binary);
    }
  }
  if (isFullyAbsolute(home)) {
    for (const editor of ['.vscode', '.cursor', '.vscode-insiders', '.vscode-server', '.cursor-server']) {
      const root = join(home, editor, 'extensions');
      for (const extension of directories(root, /^anthropic\.claude-code-\d/i)) {
        yield join(root, extension, 'resources', 'native-binary', binary);
      }
    }
  }
}

function* candidates(agent, env, home, nodeDir, pathDirs) {
  const binary = agent + (windows ? '.exe' : '');
  const entry = agent === 'codex' ? '@openai/codex/bin/codex.js' : '@anthropic-ai/claude-code/cli.js';
  if (agent === 'claude' && isFullyAbsolute(home)) {
    yield join(home, '.local', 'bin', binary);
    yield join(home, '.claude', 'local', binary);
    yield join(home, '.claude', 'local', 'node_modules', entry);
  }
  if (agent === 'codex') {
    const prefix = env.NPM_CONFIG_PREFIX ?? env.npm_config_prefix;
    const roots = [nodeDir, prefix, isFullyAbsolute(env.APPDATA) && join(env.APPDATA, 'npm')];
    if (!windows) roots.push(join(nodeDir, '..', 'lib'));
    for (const root of roots.filter(isFullyAbsolute)) {
      yield join(root, 'node_modules', entry);
      yield join(root, 'lib', 'node_modules', entry);
    }
  }
  for (const dir of pathDirs.filter(isFullyAbsolute)) {
    yield join(dir, binary);
    yield join(dir, 'node_modules', entry);
  }
  if (agent === 'claude') yield* claudeBundles(home, env, binary);
}

export function launcher(agent, override, { env = process.env, home = homedir(), nodeDir = dirname(process.execPath) } = {}) {
  if (agent !== 'claude' && agent !== 'codex') throw new Error('Unknown agent.');
  override ??= agent === 'claude' ? env.CLAUDE_BIN ?? env.CLAUDE_CLI_BIN : env.CODEX_BIN ?? env.CODEX_CLI_JS;
  const pathDirs = (env.PATH ?? '').split(delimiter).map(dir => dir.replace(/^"|"$/g, ''));
  const paths = override === undefined ? candidates(agent, env, home, nodeDir, pathDirs) : [override];
  for (const path of paths) {
    if (!isFullyAbsolute(path)) throw new Error('Configure executable as an absolute path.');
    const js = /\.[cm]?js$/i.test(path);
    if (windows && !js && !/\.exe$/i.test(path)) throw new Error('Configure a Windows .exe or JavaScript CLI entry point.');
    try {
      if (statSync(path).isFile()) {
        accessSync(path, js ? constants.R_OK : constants.X_OK);
        return js ? [process.execPath, path] : [path];
      }
    } catch { /* Try the next discovery path. Explicit overrides never fall back. */ }
  }
  if (override !== undefined) throw new Error('Configured executable does not exist or is inaccessible: ' + override);
  if (windows || (env.PATH !== undefined && pathDirs.some(dir => !isFullyAbsolute(dir)))) {
    throw new Error('Cannot find ' + agent + ' in a trusted directory. Configure its absolute executable path.');
  }
  return [agent];
}

function stopTree(child) {
  if (!child.pid) return;
  const killChild = () => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* Exit and cleanup can race. */ }
    }
  };
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const root = [process.env.SystemRoot, process.env.WINDIR].find(dir => /^[a-z]:[\\/]/i.test(dir ?? ''));
    if (!root) return killChild();
    const killer = spawn(join(root, 'System32', 'taskkill.exe'),
      ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    killer.once('error', killChild);
    killer.once('exit', code => { if (code !== 0) killChild(); });
    killer.unref();
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') killChild(); }
  }
}

export function runAgent(command, args, { cwd, input, signal, collectOutput = true, env }) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const [program, ...prefix] = command;
    const child = spawn(program, [...prefix, ...args], {
      cwd, env, stdio: ['pipe', collectOutput ? 'pipe' : 'ignore', 'pipe'],
      shell: false, windowsHide: true, detached: process.platform !== 'win32',
    });
    const stdout = [];
    let size = 0;
    let failure;
    let stderr = '';
    let drainTimer, stopTimer;
    function closePipes() {
      child.stdin.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    function stop(reason) {
      if (failure) return;
      failure = reason;
      stopTree(child);
      closePipes();
      stopTimer = setTimeout(() => {
        cleanup();
        reject(new Error(reason.message + ' Process termination unconfirmed.'));
      }, 5000);
    }
    const abort = () => {
      if (child.exitCode !== null || child.signalCode !== null) closePipes();
      else stop(new Error('Delegation cancelled or timed out.'));
    };
    signal.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', chunk => {
      size += chunk.length;
      if (size <= 4 * 1024 * 1024) stdout.push(chunk);
      else stop(new Error('Agent output exceeded 4 MiB. Request a smaller result.'));
    });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE' && !(process.platform === 'win32' && error.code === 'EOF' && error.syscall === 'write')) {
        stop(error);
      }
    });
    function cleanup() {
      clearTimeout(stopTimer);
      clearTimeout(drainTimer);
      signal.removeEventListener('abort', abort);
    }
    child.on('error', error => {
      cleanup();
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(stopTimer);
      drainTimer = setTimeout(closePipes, 500);
    });
    child.once('close', code => {
      cleanup();
      if (failure) return reject(failure);
      resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr });
    });
    child.stdin.end(input, 'utf8');
  });
}
