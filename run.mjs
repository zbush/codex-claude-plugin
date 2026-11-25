import { spawn } from 'node:child_process';
import { delimiter, join, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';

// Windows npm distributions may expose only a .cmd shim. Run the official
// package entry with Node so prompts and arguments never go through cmd.exe.
export function launcher(agent, override) {
  if (override) {
    if (!isAbsolute(override)) throw new Error('Configure executable as an absolute path.');
    return /\.[cm]?js$/i.test(override) ? [process.execPath, override] : [override];
  }
  if (process.platform === 'win32') {
    const entry = agent === 'codex' ? ['@openai', 'codex', 'bin', 'codex.js'] : ['@anthropic-ai', 'claude-code', 'cli.js'];
    for (const directory of (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)) {
      for (const parts of [[agent + '.exe'], ['node_modules', ...entry]]) {
        const candidate = join(directory, ...parts);
        if (existsSync(candidate)) return parts.length === 1 ? [candidate] : [process.execPath, candidate];
      }
    }
  }
  return [agent];
}

function stopTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    const killer = spawn(join(process.env.SystemRoot, 'System32', 'taskkill.exe'),
      ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
    killer.once('exit', code => { if (code !== 0 && child.exitCode === null) child.kill(); });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') child.kill(); }
  }
}

export function runAgent(command, args, { cwd, input, signal, collectOutput = true }) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const [program, ...prefix] = command;
    const child = spawn(program, [...prefix, ...args], {
      cwd, stdio: ['pipe', collectOutput ? 'pipe' : 'ignore', 'pipe'],
      shell: false, windowsHide: true, detached: process.platform !== 'win32',
    });
    const stdout = [];
    let size = 0;
    let failure;
    let stderr = '';
    function stop(reason) {
      if (failure) return;
      failure = reason;
      stopTree(child);
    }
    const abort = () => stop(new Error('Delegation cancelled or timed out.'));
    signal.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', chunk => {
      size += chunk.length;
      if (size <= 4 * 1024 * 1024) stdout.push(chunk);
      else stop(new Error('Agent output exceeded 4 MiB. Request a smaller result.'));
    });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr = (stderr + chunk).slice(-8192); });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop(error); });
    child.on('error', reject);
    child.once('close', code => {
      signal.removeEventListener('abort', abort);
      if (failure) return reject(failure);
      resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr });
    });
    child.stdin.end(input, 'utf8');
  });
}
