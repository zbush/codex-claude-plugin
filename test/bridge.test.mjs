import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, access, mkdir, readFile, chmod, copyFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioClient } from '../scripts/stdio-client.mjs';
import { bridgePath } from '../agents.mjs';
import { readOptions, serverArgs } from '../settings.mjs';
import { launcher, runAgent } from '../run.mjs';

const executable = fileURLToPath(new URL('../fixtures/recipient.cjs', import.meta.url));
const task = 'Review "this" & check %PATH% | $SHELL\nInclude café and 雪.';
const context = 'Relayed by another agent.\nThe human may not have read this.';

async function connect(t, direction, hops, extra = {}, bridgeContext, env = {}, flags = []) {
  const workspace = await mkdtemp(join(tmpdir(), 'bridge test '));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const config = join(workspace, 'settings with spaces.json');
  await writeFile(config, JSON.stringify({ codex: { executable }, claude: { executable }, ...extra }));
  const options = readOptions([direction, '--config', config, '--workspace', workspace, '--hops', String(hops), ...flags]);
  const args = [bridgePath, ...serverArgs({ ...options, bridgeContext })];
  const client = new StdioClient({ command: process.execPath, args, env });
  t.after(() => client.close());
  const { serverInfo } = await client.initialize({ name: 'test', version: '1' });
  const call = (taskText = task) => client.callTool({ name: 'delegate', arguments: { task: taskText, context } });
  const status = async () => JSON.parse((await client.callTool({ name: 'status' })).content[0].text);
  return { client, call, status, config, workspace, serverInfo };
}

function inspectReply(result, sender, recipient, workspace) {
  assert.ok(!result.isError, result.content[0].text);
  const [attribution, body] = result.content[0].text.split('\n\n');
  assert.equal(attribution, `Agent reply from ${recipient} to ${sender}:`);
  const record = JSON.parse(body);
  assert.equal(realpathSync(record.cwd), realpathSync(workspace));
  assert.ok(record.input.startsWith('AGENT-TO-AGENT DELEGATION\n'));
  assert.ok(record.input.includes(`Sending agent: ${sender}. Receiving agent: ${recipient}.`));
  assert.deepEqual(JSON.parse(record.input.split('\n').at(-1)), { task, context });
  assert.ok(!record.args.some(arg => arg.includes(task)));
  return record.args;
}

test('Codex-to-Claude leaf labels both sides and skips all configured MCP servers', async t => {
  const { client, call, workspace } = await connect(t, 'to-claude', 1);
  assert.deepEqual((await client.listTools()).tools.map(x => x.name), ['delegate', 'status']);
  const args = inspectReply(await call(), 'Codex', 'Claude Code', workspace);
  assert.ok(args.includes('--strict-mcp-config') && !args.includes('--mcp-config'));
  assert.ok(args.includes('--restricted'));
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  assert.ok((await call('failure')).isError);
});

test('Claude-to-Codex leaf returns only the final file, rejects partial output, and cleans up', async t => {
  const { call, workspace } = await connect(t, 'to-codex', 1);
  const args = inspectReply(await call(), 'Claude Code', 'Codex', workspace);
  assert.ok(args.includes('--ignore-user-config') && !args.some(s => s.startsWith('mcp_servers.')));
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(args.at(-1), '-');
  await assert.rejects(access(args[args.indexOf('--output-last-message') + 1]), { code: 'ENOENT' });
  assert.ok((await call('failure')).isError);
  assert.match((await call('missing')).content[0].text, /no final message/);
});

test('Claude peer receives the reverse route with one less hop and the same settings', async t => {
  const { call, workspace, config } = await connect(t, 'to-claude', 3, { claude: { executable, allowEdits: true } }, undefined, {}, ['--allow-cycles']);
  // A peer must keep the host's validated policy even when the source goes away.
  await rm(config);
  const args = inspectReply(await call(), 'Codex', 'Claude Code', workspace);
  const { 'codex-local': peer } = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers;
  assert.equal(peer.args[0], bridgePath);
  const nested = readOptions(peer.args.slice(1));
  assert.equal(nested.direction, 'to-codex');
  assert.equal(nested.workspace, workspace);
  assert.equal(nested.hops, 2);
  assert.equal(nested.bridgeContext.remaining_hops, 2);
  assert.equal(nested.bridgeContext.hops[0].from, 'codex');
  assert.deepEqual(nested.settings.claude, { executable, allowEdits: true });
  assert.ok(args[args.indexOf('--allowedTools') + 1].includes('mcp__codex-local__delegate'));
  assert.ok(args[args.indexOf('--tools') + 1].includes('Edit'));
});

test('a foreign hop limits a real MCP call and its recipient environment', async t => {
  const incoming = { version: 1, hops: [{ from: 'antigravity', to: 'codex', id: 'foreign' }], remaining_hops: 1 };
  const { call } = await connect(t, 'to-claude', 8, {}, incoming);
  const result = await call();
  assert.ok(!result.isError, result.content[0].text);
  const record = JSON.parse(result.content[0].text.split('\n\n')[1]);
  assert.equal(record.bridgeContext.remaining_hops, 0);
  assert.deepEqual(record.bridgeContext.hops[0], incoming.hops[0]);
  assert.equal(record.bridgeContext.hops[1].to, 'claude');
  assert.ok(!record.args.includes('--mcp-config'));
  const leaf = await connect(t, 'to-codex', 8, {}, record.bridgeContext);
  await assert.rejects(leaf.call(), { code: -32602, data: { reason: 'hop_budget_exhausted' } });
});

test('forwarded workspace and edit limits narrow the registered peer settings', async t => {
  const requested = { claude: { executable, allowEdits: true }, codex: { executable, allowEdits: true } };
  const host = { AGENT_BRIDGE_WORKSPACE_ROOTS: JSON.stringify([tmpdir()]), AGENT_BRIDGE_ALLOW_EDITS: 'false' };
  const { call, workspace } = await connect(t, 'to-claude', 2, requested, undefined, host, ['--allow-cycles']);
  const result = await call();
  assert.ok(!result.isError, result.content[0].text);
  const { args, roots, edits } = JSON.parse(result.content[0].text.split('\n\n')[1]);
  assert.equal(roots, JSON.stringify([realpathSync.native(workspace)]));
  assert.equal(edits, 'false');
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  const peer = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers['codex-local'];
  assert.equal(readOptions(peer.args.slice(1)).settings.codex.allowEdits, false);
  assert.equal(peer.env.AGENT_BRIDGE_WORKSPACE_ROOTS, roots);
  assert.equal(peer.env.AGENT_BRIDGE_ALLOW_EDITS, 'false');
  const outside = await connect(t, 'to-codex', 1, requested, undefined, { ...host, AGENT_BRIDGE_WORKSPACE_ROOTS: JSON.stringify([process.cwd()]) });
  await assert.rejects(outside.call(), { code: -32602, data: { reason: 'workspace_outside_roots' } });
});

test('legacy depth alone cannot reset a budget and either legacy chain can accompany v1', async t => {
  const incomplete = await connect(t, 'to-claude', 3, {}, undefined, { AGENT_BRIDGE_DEPTH: '1' });
  await assert.rejects(incomplete.call(), { code: -32602, data: { reason: 'invalid_bridge_context' } });
  const ctx = { version: 1, hops: [{ from: 'antigravity', to: 'codex', id: 'one' }], remaining_hops: 1 };
  for (const chain of ['antigravity:one', '["antigravity_to_codex"]']) {
    const host = { AGENT_BRIDGE_CONTEXT: JSON.stringify(ctx), AGENT_BRIDGE_DEPTH: '1', AGENT_BRIDGE_CHAIN: chain };
    const client = await connect(t, 'to-claude', 3, {}, undefined, host);
    const result = await client.call();
    assert.ok(!result.isError, result.content[0].text);
    const { bridgeContext } = JSON.parse(result.content[0].text.split('\n\n')[1]);
    assert.deepEqual(bridgeContext.hops[0], ctx.hops[0]);
    assert.equal(bridgeContext.remaining_hops, 0);
  }
});

test('a read-only Codex hop pins its narrowed host ceiling into the callback', async t => {
  const host = { AGENT_BRIDGE_WORKSPACE_ROOTS: JSON.stringify([tmpdir()]), AGENT_BRIDGE_ALLOW_EDITS: 'true' };
  const { call, workspace } = await connect(t, 'to-codex', 2, { claude: { executable, allowEdits: true } }, undefined, host, ['--allow-cycles']);
  const result = await call();
  assert.ok(!result.isError, result.content[0].text);
  const { args, roots, edits } = JSON.parse(result.content[0].text.split('\n\n')[1]);
  assert.equal(edits, 'false');
  assert.equal(roots, JSON.stringify([realpathSync.native(workspace)]));
  const key = 'mcp_servers.claude-local';
  assert.ok(args.includes(key + '.env.AGENT_BRIDGE_WORKSPACE_ROOTS=' + JSON.stringify(roots)));
  assert.ok(args.includes(key + '.env.AGENT_BRIDGE_ALLOW_EDITS="false"'));
  const registered = JSON.parse(args.find(s => s.startsWith(key + '.args=')).slice((key + '.args=').length));
  assert.equal(readOptions(registered.slice(1)).settings.claude.allowEdits, false);
});

test('Codex peer receives a bounded reverse route and independent recipient settings', async t => {
  const codex = { executable, model: 'test-model', allowEdits: true, windowsSandbox: 'elevated' };
  const { call, workspace } = await connect(t, 'to-codex', 2, { codex }, undefined, {}, ['--allow-cycles']);
  const args = inspectReply(await call(), 'Claude Code', 'Codex', workspace);
  const prefix = 'mcp_servers.claude-local.args=';
  const reverse = JSON.parse(args.find(arg => arg.startsWith(prefix)).slice(prefix.length));
  assert.equal(reverse[0], bridgePath);
  const nested = readOptions(reverse.slice(1));
  assert.equal(nested.direction, 'to-claude');
  assert.equal(nested.workspace, workspace);
  assert.equal(nested.hops, 1);
  assert.deepEqual(nested.settings.codex, codex);
  assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.equal(args[args.indexOf('--model') + 1], 'test-model');
  assert.equal(args.includes('windows.sandbox="elevated"'), process.platform === 'win32');
});

test('overlapping Codex calls keep their task and final answer files separate', async t => {
  const { call } = await connect(t, 'to-codex', 1);
  const tasks = ['first', 'second'];
  const results = await Promise.all(tasks.map(call));
  const paths = results.map((result, index) => {
    assert.ok(!result.isError);
    const record = JSON.parse(result.content[0].text.split('\n\n')[1]);
    assert.equal(JSON.parse(record.input.split('\n').at(-1)).task, tasks[index]);
    return record.args[record.args.indexOf('--output-last-message') + 1];
  });
  assert.notEqual(paths[0], paths[1]);
});

test('timeout stops the recipient and returns an MCP error', { timeout: 15000 }, async t => {
  const { call } = await connect(t, 'to-codex', 1, { timeoutSeconds: 1 });
  assert.match((await call('timeout')).content[0].text, /cancelled or timed out/);
});

test('invalid hop counts fail before starting a server', () => {
  for (const hops of ['0', '-1', 'Infinity', '2oops']) {
    assert.throws(() => readOptions(['to-claude', `--hops=${hops}`]), /positive integer/);
  }
});

test('a finished recipient returns its answer even when a descendant inherits stderr', { timeout: 5000 }, async () => {
  const parentProgram = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 8000)'], {
      stdio: ['ignore', 'ignore', 2], windowsHide: true,
    });
    child.unref();
    console.log('complete reply');
  `;
  const result = await runAgent([process.execPath], ['-e', parentProgram], {
    input: '', signal: AbortSignal.timeout(2500),
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), 'complete reply');
});

test('registration snapshots round trip and reject conflicting settings sources', () => {
  const options = readOptions(['to-claude']);
  const args = serverArgs(options);
  assert.deepEqual(readOptions(args), options);
  assert.throws(() => readOptions([...args, '--config', 'unused']), /one settings source/);
  assert.throws(() => readOptions(['to-claude', '--config', 'missing'], { allowConfigFile: false }), /Replace it using scripts\/register/);
});

test('discovery ignores relative PATH directories', () => {
  assert.throws(() => launcher('claude', undefined, { env: { PATH: '.' }, home: '' }), /absolute executable path/);
});

test('Windows discovery accepts a quoted PATH directory with spaces', { skip: process.platform !== 'win32' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'quoted bridge bin '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = join(dir, 'claude.exe');
  await writeFile(cli, '');
  assert.deepEqual(launcher('claude', undefined, { home: '', env: { PATH: '"' + dir + '"' } }), [cli]);
});

async function tempDirectory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge check '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('status reports server identity, effective policy, inherited context and the resolved CLI', async t => {
  const prior = { version: 1, remaining_hops: 2, hops: [{ from: 'antigravity', to: 'claude', id: 'prior' }] };
  const env = { AGENT_BRIDGE_CONTEXT: JSON.stringify(prior), AGENT_BRIDGE_WORKSPACE_ROOTS: JSON.stringify([tmpdir()]),
    AGENT_BRIDGE_ALLOW_EDITS: 'false', AGENT_BRIDGE_MAX_CONCURRENT: '2' };
  const bridge = await connect(t, 'to-codex', 3, { codex: { executable, model: 'model', allowEdits: true } }, undefined, env);
  assert.equal(bridge.serverInfo.name, 'codex-local');
  assert.equal(bridge.serverInfo.version, '2.0.0');
  assert.deepEqual(await bridge.status(), {
    server_name: 'codex-local', direction: 'to-codex', sender: 'Claude Code', recipient: 'Codex',
    workspace: bridge.workspace, executable, active_calls: 0, bridge_context: prior,
    settings: { allowEdits: false, model: 'model', timeoutSeconds: 300, allowCycles: false, maxConcurrent: 2, hops: 3 },
    workspace_policy: { roots: [realpathSync.native(tmpdir())], roots_source: 'env', allow_edits: false },
  });
  assert.ok((await bridge.client.listTools()).tools.find(tool => tool.name === 'status').annotations.readOnlyHint);
  const missing = join(bridge.workspace, 'not-installed.js');
  const other = await connect(t, 'to-claude', 1, { claude: { executable: missing } });
  const report = await other.status();
  assert.equal(other.serverInfo.name, 'claude-local');
  assert.equal(report.executable, null);
  assert.match(report.executable_error, /not-installed/);
  assert.equal(report.settings.maxConcurrent, 4);
  assert.equal(report.bridge_context, null);
  assert.ok(!('workspace_policy' in report));
  assert.ok((await other.call()).isError);
});

test('cycles are blocked by default and an explicitly enabled callback completes the return hop', async t => {
  const root = await connect(t, 'to-claude', 3);
  const record = JSON.parse((await root.call()).content[0].text.split('\n\n')[1]);
  assert.ok(!record.args.includes('--mcp-config'));
  const blocked = await connect(t, 'to-codex', 2, {}, record.bridgeContext);
  await assert.rejects(blocked.call(), { code: -32602, data: { reason: 'cycle_blocked' } });
  const enabled = await connect(t, 'to-claude', 2, {}, undefined, {}, ['--allow-cycles']);
  const args = inspectReply(await enabled.call(), 'Codex', 'Claude Code', enabled.workspace);
  const peer = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers['codex-local'];
  const client = new StdioClient(peer);
  t.after(() => client.close());
  await client.initialize({ name: 'callback-test', version: '1' });
  const result = await client.callTool({ name: 'delegate', arguments: { task, context } });
  inspectReply(result, 'Claude Code', 'Codex', enabled.workspace);
  const child = JSON.parse(result.content[0].text.split('\n\n')[1]).bridgeContext;
  assert.deepEqual(child.hops.map(h => h.to), ['claude', 'codex']);
  assert.equal(child.remaining_hops, 0);
});

test('cycle policy distinguishes a default from an explicit denial and invalid host limits fail closed', async t => {
  for (const [settings, env, expected] of [
    [{}, 'true', true], [{ allowCycles: false }, 'true', false], [{ allowCycles: true }, 'false', false],
  ]) {
    const bridge = await connect(t, 'to-codex', 2, settings, undefined, { AGENT_BRIDGE_ALLOW_CYCLES: env });
    assert.equal((await bridge.status()).settings.allowCycles, expected);
    const args = inspectReply(await bridge.call(), 'Claude Code', 'Codex', bridge.workspace);
    assert.equal(args.some(arg => arg.startsWith('mcp_servers.claude-local.')), expected);
  }
  for (const env of [{ AGENT_BRIDGE_ALLOW_CYCLES: 'TRUE' }, { AGENT_BRIDGE_MAX_CONCURRENT: '0' },
    { AGENT_BRIDGE_MAX_CONCURRENT: '2x' }]) {
    const bridge = await connect(t, 'to-claude', 2, {}, undefined, env, ['--allow-cycles']);
    await assert.rejects(bridge.call(), { code: -32602, data: { reason: 'invalid_host_policy' } });
    assert.equal((await bridge.status()).active_calls, 0);
  }
  const narrower = await connect(t, 'to-codex', 1, { maxConcurrent: 2 }, undefined, { AGENT_BRIDGE_MAX_CONCURRENT: '7' });
  assert.equal((await narrower.status()).settings.maxConcurrent, 2);
});

test('notifications/cancelled releases just its delegation slot while status and ping stay available', { timeout: 15000 }, async t => {
  const bridge = await connect(t, 'to-claude', 1, { maxConcurrent: 3 }, undefined, { AGENT_BRIDGE_MAX_CONCURRENT: '2' });
  const controllers = [new AbortController(), new AbortController()];
  const calls = controllers.map(({ signal }) =>
    bridge.client.callTool({ name: 'delegate', arguments: { task: 'timeout' } }, { signal }));
  assert.equal((await bridge.status()).active_calls, 2);
  await assert.rejects(bridge.call(), { code: -32602, data: { reason: 'max_concurrent_reached' } });
  assert.deepEqual(await bridge.client.request('ping'), {});
  bridge.client.notify('notifications/cancelled', { requestId: 'unknown' });
  for (const [index, controller] of controllers.entries()) {
    const rejected = assert.rejects(calls[index], { name: 'AbortError' });
    controller.abort();
    await rejected;
    const expected = 1 - index;
    const expiry = Date.now() + 5000;
    while ((await bridge.status()).active_calls !== expected) {
      assert.ok(Date.now() < expiry, 'server did not release the cancelled slot');
      await delay(20);
    }
    assert.ok(!(await bridge.call()).isError);
  }
});

test('Claude receives neither nested-session marker and Codex keeps its inherited environment', async t => {
  const env = { CLAUDECODE: 'present', CLAUDE_CODE_ENTRYPOINT: 'present' };
  for (const direction of ['to-claude', 'to-codex']) {
    const bridge = await connect(t, direction, 1, {}, undefined, env);
    const record = JSON.parse((await bridge.call()).content[0].text.split('\n\n')[1]);
    const expected = direction === 'to-codex' ? 'present' : undefined;
    assert.equal(record.claudeCode, expected);
    assert.equal(record.entrypoint, expected);
  }
});

test('malformed tool calls receive invalid-params errors and unknown methods receive method-not-found', async t => {
  const { client } = await connect(t, 'to-claude', 1);
  for (const params of [null, [], { name: 'missing' }, { name: 'status', arguments: { extra: 1 } },
    ...[null, {}, [], { task: ' ' }, { task: 3 }, { task: 't', context: null }, { task: 't', extra: false },
      { task: 'x'.repeat(100001) }].map(args => ({ name: 'delegate', arguments: args }))]) {
    await assert.rejects(client.request('tools/call', params), { code: -32602, data: { reason: 'invalid_params' } });
  }
  await assert.rejects(client.request('other/method'), { code: -32601 });
  assert.deepEqual(await client.request('ping'), {});
});

test('settings validation is strict at every level', () => {
  for (const value of [null, [], { other: 1 }, { claude: null }, { codex: [] }, { claude: { windowsSandbox: 'mxc' } },
    { codex: { windowsSandbox: 'unknown' } }, { claude: { executable: '' } }, { codex: { model: 42 } },
    { claude: { allowEdits: null } }, { codex: { surprise: true } }, { allowCycles: 'true' }, { allowCycles: null },
    { timeoutSeconds: 86401 }, { timeoutSeconds: 0 }, { timeoutSeconds: null }, { maxConcurrent: 0 },
    { maxConcurrent: 1.5 }, { maxConcurrent: '2' }]) {
    assert.throws(() => readOptions(['to-codex', '--settings-json', JSON.stringify(value)]));
  }
  for (const value of [{}, { allowCycles: false }, { allowCycles: true, maxConcurrent: 1 }]) {
    const opts = readOptions(['to-codex', '--settings-json', JSON.stringify(value)]);
    assert.deepEqual(readOptions(serverArgs(opts)), opts);
  }
});

test('failed subprocess spawn releases its abort listener before rejection', async t => {
  const dir = await tempDirectory(t);
  const { signal } = new AbortController();
  await assert.rejects(runAgent([join(dir, 'missing.exe')], [], { cwd: dir, input: '', signal }), { code: 'ENOENT' });
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});

test('CLI overrides have deterministic precedence and reject unsafe paths', async t => {
  const dir = await tempDirectory(t);
  const fallback = join(dir, 'fallback.js');
  await writeFile(fallback, '');
  for (const [agent, primary, secondary] of [['claude', 'CLAUDE_BIN', 'CLAUDE_CLI_BIN'], ['codex', 'CODEX_BIN', 'CODEX_CLI_JS']]) {
    const env = { [secondary]: fallback };
    assert.deepEqual(launcher(agent, undefined, { env }), [process.execPath, fallback]);
    env[primary] = executable;
    assert.deepEqual(launcher(agent, undefined, { env }), [process.execPath, executable]);
    assert.deepEqual(launcher(agent, fallback, { env }), [process.execPath, fallback]);
    env[primary] = 'relative.js';
    assert.throws(() => launcher(agent, undefined, { env }), /absolute path/);
    if (process.platform === 'win32') {
      for (const ext of ['cmd', 'bat', 'ps1']) {
        env[primary] = join(dir, 'shim.' + ext);
        await writeFile(env[primary], '');
        assert.throws(() => launcher(agent, undefined, { env }), /Windows .exe/);
      }
    }
  }
});

test('CLI discovery finds native, desktop, extension and npm installations without PATH', async t => {
  const dir = await tempDirectory(t);
  const binary = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const env = { PATH: dir, APPDATA: join(dir, 'roaming'), NPM_CONFIG_PREFIX: join(dir, 'prefix') };
  const locations = { home: dir, nodeDir: join(dir, 'node'), env };
  const candidates = [
    join(dir, '.local', 'bin', binary), join(dir, '.claude', 'local', binary), join(dir, binary),
    join(env.APPDATA, 'Claude', 'claude-code', '2.1.100', binary),
    join(dir, '.vscode', 'extensions', 'anthropic.claude-code-2.1.100', 'resources', 'native-binary', binary),
    join(dir, '.cursor', 'extensions', 'anthropic.claude-code-2.1.100', 'resources', 'native-binary', binary),
  ];
  for (const path of candidates) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '');
    await chmod(path, 0o755);
    assert.deepEqual(launcher('claude', undefined, locations), [path]);
    await rm(path);
  }
  for (const root of [locations.nodeDir, env.NPM_CONFIG_PREFIX, join(env.NPM_CONFIG_PREFIX, 'lib'), join(env.APPDATA, 'npm')]) {
    const path = join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '');
    assert.deepEqual(launcher('codex', undefined, locations), [process.execPath, path]);
    await rm(path);
  }
});

test('bridge initializes without an icon or installed packages', async t => {
  const dir = await tempDirectory(t);
  for (const file of ['bridge.mjs', 'agents.mjs', 'mcp.mjs', 'settings.mjs', 'context.mjs', 'run.mjs', 'workspace-policy.mjs']) {
    await copyFile(join(dirname(bridgePath), file), join(dir, file));
  }
  const client = new StdioClient({ command: process.execPath, args: [join(dir, 'bridge.mjs'), 'to-claude'] });
  t.after(() => client.close());
  const result = await client.initialize({ name: 'no-icon-test', version: '1' });
  assert.deepEqual(result.serverInfo, { name: 'claude-local', version: '2.0.0' });
});

const runFile = promisify(execFile);
const register = join(dirname(bridgePath), 'scripts', 'register.mjs');
const requiredVars = [
  'AGENT_BRIDGE_CONTEXT', 'AGENT_BRIDGE_DEPTH', 'AGENT_BRIDGE_CHAIN', 'AGENT_BRIDGE_WORKSPACE_ROOTS',
  'AGENT_BRIDGE_ALLOW_EDITS', 'AGENT_BRIDGE_ALLOW_CYCLES', 'AGENT_BRIDGE_MAX_CONCURRENT',
  'CLAUDE_BIN', 'CLAUDE_CLI_BIN', 'CODEX_BIN', 'CODEX_CLI_JS',
];

test('stdio returns parse, envelope and internal errors and continues processing', async () => {
  const moduleUrl = new URL('../mcp.mjs', import.meta.url).href;
  const program = 'import { serve } from ' + JSON.stringify(moduleUrl) + ';' +
    'serve({serverInfo: {}, tools: [{name: "broken"}], callTool() { throw new Error("unexpected"); }});';
  const child = runFile(process.execPath, ['--input-type=module', '-e', program], { windowsHide: true });
  const call = { jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name: 'broken' } };
  child.child.stdin.end(['{', 'null', JSON.stringify(call), '{"jsonrpc":"2.0","id":0,"method":"ping"}'].join('\n') + '\n');
  const { stdout } = await child;
  const replies = stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies.length, 4);
  assert.deepEqual(replies.filter(r => r.id === null).map(r => r.error.code), [-32700, -32600]);
  assert.equal(replies.find(r => r.id === 'call').error.code, -32603);
  assert.deepEqual(replies.find(r => r.id === 0).result, {});
});

test('one-shot ask uses the same stdio negotiation, CLI override and attributed reply', async t => {
  const dir = await tempDirectory(t);
  const ask = join(dirname(register), 'ask.mjs');
  const env = { ...process.env, CLAUDE_BIN: executable };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('AGENT_BRIDGE_')) delete env[key];
  }
  const child = runFile(process.execPath, [ask, 'to-claude', '--workspace', dir], { env, windowsHide: true });
  child.child.stdin.end(task);
  const { stdout } = await child;
  assert.match(stdout, /^Agent reply from Claude Code to Codex:/);
  const record = JSON.parse(stdout.split('\n\n')[1]);
  assert.deepEqual(JSON.parse(record.input.split('\n').at(-1)), { task });
});

test('registration selects the correct host, server, scope and version-checked forwarding update', async t => {
  const dir = await tempDirectory(t);
  const record = join(dir, 'record.json');
  const host = join(dirname(executable), 'registration.cjs');
  const env = { ...process.env, REGISTRATION_RECORD: record, CODEX_BIN: host, CLAUDE_BIN: host };
  const run = async (...args) => {
    await runFile(process.execPath, [register, ...args], { env, windowsHide: true });
    return JSON.parse(await readFile(record, 'utf8'));
  };
  const { edits, expectedVersion, filePath } = await run('to-claude', '--hops', '3', '--allow-cycles');
  assert.equal(expectedVersion, 'initial');
  assert.equal(filePath, 'config.toml');
  const [command, args, vars] = edits;
  assert.deepEqual(edits.map(edit => edit.keyPath), ['command', 'args', 'env_vars'].map(key => 'mcp_servers.claude-local.' + key));
  assert.ok(edits.every(edit => edit.mergeStrategy === 'replace'));
  assert.equal(command.value, process.execPath);
  assert.equal(args.value[0], bridgePath);
  assert.ok(readOptions(args.value.slice(1)).settings.allowCycles);
  assert.deepEqual([...vars.value].sort(), ['KEEP', ...requiredVars].sort());
  assert.deepEqual(await run('to-claude', '--status'), ['mcp', 'get', 'claude-local']);
  assert.deepEqual(await run('--remove', 'to-claude'), ['mcp', 'remove', 'claude-local']);
  assert.deepEqual(await run('to-codex', '--status'), ['mcp', 'get', 'codex-local']);
  assert.deepEqual(await run('to-codex', '--remove'), ['mcp', 'remove', 'codex-local', '--scope', 'user']);
  const add = await run('to-codex');
  assert.deepEqual(add.slice(0, 8), ['mcp', 'add', 'codex-local', '--scope', 'user', '--', process.execPath, bridgePath]);
  assert.equal(readOptions(add.slice(8)).direction, 'to-codex');
});

test('Codex registration patches real user TOML and removal preserves other registrations', async t => {
  const dir = await tempDirectory(t);
  const env = { ...process.env, CODEX_HOME: dir };
  let command, prefix;
  try {
    [command, ...prefix] = launcher('codex');
    await runFile(command, [...prefix, '--version'], { env, windowsHide: true });
  } catch { return t.skip('Codex CLI unavailable for the native TOML integration test'); }
  const path = join(dir, 'config.toml');
  const other = '[mcp_servers.other]\ncommand = "other-cli"\n';
  await writeFile(path, other + '[mcp_servers.claude-local]\ncommand = "old"\ntool_timeout_sec = 77\n' +
    "env_vars = [\n  'EXISTING', # keep this variable\n  'CLAUDE_BIN',\n]\n");
  const run = (...args) => runFile(process.execPath, [register, 'to-claude', ...args], { env, windowsHide: true });
  await run();
  await run();
  const toml = await readFile(path, 'utf8');
  assert.ok(toml.includes('[mcp_servers.claude-local]'));
  const { stdout } = await runFile(command, [...prefix, 'mcp', 'get', 'claude-local', '--json'], { env, windowsHide: true });
  const server = JSON.parse(stdout);
  assert.equal(server.tool_timeout_sec, 77);
  assert.equal(server.transport.command, process.execPath);
  assert.deepEqual(server.transport.env_vars.sort(), ['EXISTING', ...requiredVars].sort());
  assert.match((await run('--status')).stdout, /claude-local/);
  await run('--remove');
  const after = await readFile(path, 'utf8');
  assert.ok(after.includes('[mcp_servers.other]'));
  assert.ok(!after.includes('[mcp_servers.claude-local]'));
});
