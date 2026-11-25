import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rmdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { routes, serverArgs } from './settings.mjs';
import { launcher, runAgent } from './run.mjs';

export const bridgePath = fileURLToPath(new URL('./bridge.mjs', import.meta.url));

function reciprocalServer(options) {
  if (options.hops === 1) return;
  const direction = routes[options.direction].reverse;
  return {
    command: process.execPath,
    args: [bridgePath, ...serverArgs({ ...options, direction, hops: options.hops - 1 })],
  };
}

export function delegationPrompt(route, task, context) {
  return [
    'AGENT-TO-AGENT DELEGATION',
    `Sending agent: ${route.sender}. Receiving agent: ${route.recipient}.`,
    'This task and its context were supplied by the sending agent. The human may never have seen that conversation.',
    'Reply to the sending agent. Attribute relayed claims to that agent and do not imply the human said them or took part in earlier chats.',
    JSON.stringify({ task, ...(context === undefined ? {} : { context }) }),
  ].join('\n');
}

async function askClaude(options, prompt, signal) {
  const { settings, workspace } = options;
  const config = settings.claude;
  const tools = config.allowEdits ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep';
  const peer = reciprocalServer(options);
  const allowed = peer ? tools + ',mcp__codex_delegate__delegate' : tools;
  const args = ['-p', '--restricted', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config',
    '--permission-mode', 'dontAsk', '--tools', tools, '--allowedTools', allowed];
  if (peer) args.push('--mcp-config', JSON.stringify({ mcpServers: { codex_delegate: peer } }));
  if (config.model) args.push('--model', config.model);
  const result = await runAgent(launcher('claude', config.executable), args, { cwd: workspace, input: prompt, signal });
  let response;
  try { response = JSON.parse(result.stdout); } catch { /* Handle empty or invalid CLI output below. */ }
  if (result.code !== 0 || response?.is_error || !response?.result?.trim()) {
    if (/unknown option[^\n]*--restricted/i.test(result.stderr)) throw new Error('Restricted delegation requires Claude Code 2.1.248 or newer.');
    throw new Error(`Claude Code failed (exit ${result.code}). ${response?.result || result.stderr.trim() || 'Check Claude Code sign-in and CLI configuration.'}`);
  }
  return response.result;
}

async function askCodex(options, prompt, signal) {
  const { settings, workspace } = options;
  const config = settings.codex;
  const dir = await mkdtemp(join(tmpdir(), 'codex-delegate-'));
  const out = join(dir, 'reply.txt');
  try {
    const args = ['--no-daemon', '-a', 'never', 'exec', '--ephemeral', '--ignore-user-config',
      '--skip-git-repo-check', '--sandbox', config.allowEdits ? 'workspace-write' : 'read-only',
      '--color', 'never', '--output-last-message', out];
    if (process.platform === 'win32' && config.windowsSandbox) {
      args.push('-c', `windows.sandbox=${JSON.stringify(config.windowsSandbox)}`);
    }
    const peer = reciprocalServer(options);
    if (peer) {
      const key = 'mcp_servers.claude_delegate';
      args.push('-c', `${key}.command=${JSON.stringify(peer.command)}`,
        '-c', `${key}.args=${JSON.stringify(peer.args)}`,
        '-c', `${key}.tool_timeout_sec=${settings.timeoutSeconds}`,
        '-c', `${key}.tools.delegate.approval_mode="approve"`,
        '-c', `${key}.required=true`);
    }
    if (config.model) args.push('--model', config.model);
    args.push('-');
    const result = await runAgent(launcher('codex', config.executable), args, { cwd: workspace, input: prompt, signal, collectOutput: false });
    if (result.code !== 0) throw new Error(`Codex exited ${result.code}. ${result.stderr.trim().slice(-2000)}`);
    const info = await stat(out).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!info?.size) throw new Error('Codex produced no final message.');
    if (info.size > 4 * 1024 * 1024) throw new Error('Codex final message exceeded 4 MiB.');
    const answer = (await readFile(out, 'utf8')).trim();
    if (!answer) throw new Error('Codex produced an empty final message.');
    return answer;
  } finally {
    await rm(out, { force: true });
    await rmdir(dir);
  }
}

export async function delegate(options, { task, context }, signal) {
  const route = routes[options.direction];
  const prompt = delegationPrompt(route, task, context);
  const ask = route.agent === 'claude' ? askClaude : askCodex;
  const answer = await ask(options, prompt, signal);
  return `Agent reply from ${route.recipient} to ${route.sender}:\n\n${answer}`;
}
