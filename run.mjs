import { spawn } from 'node:child_process';
import { delimiter, join, isAbsolute } from 'node:path';
import { statSync } from 'node:fs';

// Windows npm distributions may expose only a .cmd shim. Run the official
// package entry with Node so prompts and arguments never go through cmd.exe.
export function launcher(agent, override) {
  if (override) {
    if (!isAbsolute(override)) throw new Error('Configure executable as an absolute path.');
    if (!statSync(override, { throwIfNoEntry: false })?.isFile()) throw new Error('Configured executable does not exist: ' + override);
    if (/\.[cm]?js$/i.test(override)) return [process.execPath, override];
    if (process.platform === 'win32' && !/\.exe$/i.test(override)) throw new Error('Configure a Windows .exe or JavaScript CLI entry point.');
    return [override];
  }
  if (process.platform === 'win32') {
    const entry = agent === 'codex' ? ['@openai', 'codex', 'bin', 'codex.js'] : ['@anthropic-ai', 'claude-code', 'cli.js'];
    const directories = (process.env.PATH ?? '').split(delimiter).map(dir => dir.replace(/^"|"$/g, ''));
    for (const directory of directories.filter(isAbsolute)) {
      for (const parts of [[agent + '.exe'], ['node_modules', ...entry]]) {
        const candidate = join(directory, ...parts);
        if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return parts.length === 1 ? [candidate] : [process.execPath, candidate];
      }
    }
    throw new Error('Cannot find ' + agent + '.exe or its npm entry in an absolute PATH directory. Configure its absolute executable path (.exe or JavaScript).');
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
      stopTimer = setTimeout(() => reject(new Error(reason.message + ' Process termination unconfirmed.')), 5000);
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
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop(error); });
    child.on('error', reject);
    child.once('exit', () => {
      clearTimeout(stopTimer);
      drainTimer = setTimeout(closePipes, 500);
    });
    child.once('close', code => {
      clearTimeout(stopTimer);
      clearTimeout(drainTimer);
      signal.removeEventListener('abort', abort);
      if (failure) return reject(failure);
      resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr });
    });
    child.stdin.end(input, 'utf8');
  });
}
