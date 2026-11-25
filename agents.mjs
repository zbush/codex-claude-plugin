import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rmdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { forwardedVars, hostLimits, routes, serverArgs } from './settings.mjs';
import { nextContext, readContext } from './context.mjs';
import { EDITS_ENV, ROOTS_ENV, describeWorkspacePolicy, loadWorkspacePolicy, resolveWorkspaceDir } from './workspace-policy.mjs';
import { launcher, runAgent } from './run.mjs';
import { invalidParams } from './mcp.mjs';

export const bridgePath = fileURLToPath(new URL('./bridge.mjs', import.meta.url));
export class AgentExecutionError extends Error {}

function reciprocalServer(options, childContext, env) {
  // The current sender has just been added to hops. A reciprocal call revisits it.
  if (!childContext.remaining_hops || !options.settings.allowCycles) return;
  const direction = routes[options.direction].reverse;
  const peerEnv = Object.fromEntries(forwardedVars.filter(key => env[key] !== undefined).map(key => [key, env[key]]));
  return {
    command: process.execPath,
    args: [bridgePath, ...serverArgs({ ...options, direction, hops: childContext.remaining_hops, bridgeContext: childContext })],
    env: peerEnv,
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

async function askClaude(options, prompt, signal, childContext, env) {
  const { settings, workspace } = options;
  const config = settings.claude;
  const tools = config.allowEdits ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep';
  const peer = reciprocalServer(options, childContext, env);
  const allowed = peer ? tools + ',mcp__codex-local__delegate' : tools;
  const args = ['-p', '--restricted', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config',
    '--permission-mode', 'dontAsk', '--tools', tools, '--allowedTools', allowed];
  if (peer) args.push('--mcp-config', JSON.stringify({ mcpServers: { 'codex-local': peer } }));
  if (config.model) args.push('--model', config.model);
  for (const key of Object.keys(env)) {
    if (['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'].includes(key.toUpperCase())) delete env[key];
  }
  const result = await runAgent(launcher('claude', config.executable), args, { cwd: workspace, input: prompt, signal, env });
  let response;
  try { response = JSON.parse(result.stdout); } catch { /* Handle empty or invalid CLI output below. */ }
  if (result.code !== 0 || response?.is_error || !response?.result?.trim()) {
    if (/unknown option[^\n]*--restricted/i.test(result.stderr)) throw new Error('Restricted delegation requires Claude Code 2.1.248 or newer.');
    throw new Error(`Claude Code failed (exit ${result.code}). ${response?.result || result.stderr.trim() || 'Check Claude Code sign-in and CLI configuration.'}`);
  }
  return response.result;
}

async function askCodex(options, prompt, signal, childContext, env) {
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
    const peer = reciprocalServer(options, childContext, env);
    if (peer) {
      const key = 'mcp_servers.claude-local';
      args.push('-c', `${key}.command=${JSON.stringify(peer.command)}`,
        '-c', `${key}.args=${JSON.stringify(peer.args)}`,
        '-c', `${key}.tool_timeout_sec=${settings.timeoutSeconds}`,
        '-c', `${key}.tools.delegate.approval_mode="approve"`,
        '-c', `${key}.required=true`);
      for (const [name, value] of Object.entries(peer.env ?? {})) {
        args.push('-c', `${key}.env.${name}=${JSON.stringify(value)}`);
      }
    }
    if (config.model) args.push('--model', config.model);
    args.push('-');
    const result = await runAgent(launcher('codex', config.executable), args, { cwd: workspace, input: prompt, signal, collectOutput: false, env });
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

function effectiveOptions(options) {
  const route = routes[options.direction];
  const { allowCycles, maxConcurrent, errors } = hostLimits(options, process.env);
  const settings = { ...options.settings, allowCycles, maxConcurrent };
  let ceiling;
  if (process.env[ROOTS_ENV] !== undefined || process.env[EDITS_ENV] !== undefined) {
    ceiling = loadWorkspacePolicy({ cwd: options.workspace });
    const allowEdits = ceiling.allowEdits && settings[route.agent].allowEdits;
    for (const agent of ['codex', 'claude']) {
      settings[agent] = { ...settings[agent], allowEdits: settings[agent].allowEdits && allowEdits };
    }
  }
  return { ...options, settings, cyclesConfigured: true, ceiling, errors };
}

function priorContext(options, from) {
  let inherited;
  try { inherited = readContext(process.env.AGENT_BRIDGE_CONTEXT, from); }
  catch (error) { throw invalidParams(error.message, 'invalid_bridge_context'); }
  if (inherited && options.bridgeContext && JSON.stringify(inherited) !== JSON.stringify(options.bridgeContext)) {
    throw invalidParams('The registered callback context differs from the inherited context.', 'invalid_bridge_context');
  }
  const prior = options.bridgeContext ?? inherited;
  const depth = process.env.AGENT_BRIDGE_DEPTH;
  const chain = process.env.AGENT_BRIDGE_CHAIN;
  if (!prior && ((depth !== undefined && depth !== '0') || (chain && chain !== '[]'))) {
    throw invalidParams('Nested delegation requires AGENT_BRIDGE_CONTEXT. Update the host registration to forward it.', 'invalid_bridge_context');
  }
  if (depth !== undefined && depth !== String(prior?.hops.length ?? 0)) {
    throw invalidParams('Delegation depth disagrees with AGENT_BRIDGE_CONTEXT.', 'invalid_bridge_context');
  }
  return prior;
}

export function status(rawOptions, activeCalls) {
  const options = effectiveOptions(rawOptions);
  const route = routes[options.direction];
  const { model, executable, allowEdits } = options.settings[route.agent];
  const { allowCycles, maxConcurrent, timeoutSeconds } = options.settings;
  const report = {
    server_name: route.name, direction: options.direction, sender: route.sender, recipient: route.recipient,
    workspace: options.workspace, executable: null,
    settings: { allowEdits, model: model ?? null, timeoutSeconds, allowCycles, maxConcurrent, hops: options.hops },
    active_calls: activeCalls, bridge_context: null,
  };
  try {
    const path = launcher(route.agent, executable).at(-1);
    if (isAbsolute(path)) report.executable = path;
    else report.executable_error = 'Could not resolve ' + path + ' on PATH.';
  }
  catch (error) { report.executable_error = error.message; }
  try { report.bridge_context = priorContext(options, routes[route.reverse].agent) ?? null; }
  catch (error) { report.bridge_context_error = error.message; }
  if (options.ceiling) report.workspace_policy = describeWorkspacePolicy(options.ceiling);
  if (options.errors.length) report.policy_errors = options.errors;
  return report;
}

export async function delegate(rawOptions, { task, context }, signal) {
  let options = effectiveOptions(rawOptions);
  const route = routes[options.direction];
  const from = routes[route.reverse].agent;
  if (options.errors.length) throw invalidParams(options.errors.join(' '), 'invalid_host_policy');
  if (options.ceiling) {
    try { options = { ...options, workspace: resolveWorkspaceDir(options.ceiling, options.workspace) }; }
    catch (error) { throw invalidParams(error.message, error.code ?? 'invalid_workspace_policy'); }
  }
  const prior = priorContext(options, from);
  if (prior?.remaining_hops === 0) throw invalidParams('Delegation hop budget exhausted.', 'hop_budget_exhausted');
  if (!options.settings.allowCycles && prior?.hops.some(hop => hop.from === route.agent)) {
    throw invalidParams('Delegation would revisit ' + route.recipient + '.', 'cycle_blocked');
  }
  const childContext = nextContext(prior, from, route.agent, options.hops);
  const env = { ...process.env, AGENT_BRIDGE_CONTEXT: JSON.stringify(childContext),
    AGENT_BRIDGE_DEPTH: String(childContext.hops.length),
    AGENT_BRIDGE_ALLOW_CYCLES: String(options.settings.allowCycles),
    AGENT_BRIDGE_MAX_CONCURRENT: String(options.settings.maxConcurrent),
    AGENT_BRIDGE_CHAIN: JSON.stringify(childContext.hops.map(hop => hop.from + '_to_' + hop.to)) };
  if (options.ceiling) {
    env[ROOTS_ENV] = JSON.stringify([options.workspace]);
    env[EDITS_ENV] = String(options.settings[route.agent].allowEdits);
  }
  const prompt = delegationPrompt(route, task, context);
  const ask = route.agent === 'claude' ? askClaude : askCodex;
  let answer;
  try { answer = await ask(options, prompt, signal, childContext, env); }
  catch (error) { throw new AgentExecutionError(error.message, { cause: error }); }
  return `Agent reply from ${route.recipient} to ${route.sender}:\n\n${answer}`;
}
