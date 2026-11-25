import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bridgePath } from '../agents.mjs';
import { readOptions } from '../settings.mjs';

const executable = fileURLToPath(new URL('../fixtures/recipient.cjs', import.meta.url));
const task = 'Review "this" & check %PATH% | $SHELL\nInclude café and 雪.';
const context = 'Relayed by another agent.\nThe human may not have read this.';

async function connect(t, direction, hops, extra = {}) {
  const workspace = await mkdtemp(join(tmpdir(), 'bridge test '));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const config = join(workspace, 'settings with spaces.json');
  await writeFile(config, JSON.stringify({ codex: { executable }, claude: { executable }, ...extra }));
  const client = new Client({ name: 'test', version: '1' });
  const args = [bridgePath, direction, '--config', config, '--workspace', workspace, '--hops', String(hops)];
  await client.connect(new StdioClientTransport({ command: process.execPath, args }));
  t.after(() => client.close());
  const call = (taskText = task) => client.callTool({ name: 'delegate', arguments: { task: taskText, context } });
  return { client, call, config, workspace };
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
  assert.deepEqual((await client.listTools()).tools.map(x => x.name), ['delegate']);
  const args = inspectReply(await call(), 'Codex', 'Claude Code', workspace);
  assert.ok(args.includes('--strict-mcp-config') && !args.includes('--mcp-config'));
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
  const { call, workspace, config } = await connect(t, 'to-claude', 3, { claude: { executable, allowEdits: true } });
  const args = inspectReply(await call(), 'Codex', 'Claude Code', workspace);
  const { codex_delegate: peer } = JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers;
  assert.deepEqual(peer.args, [bridgePath, 'to-codex', '--hops', '2', '--config', config, '--workspace', workspace]);
  assert.ok(args[args.indexOf('--allowedTools') + 1].includes('mcp__codex_delegate__delegate'));
  assert.ok(args[args.indexOf('--tools') + 1].includes('Edit'));
});

test('Codex peer receives a bounded reverse route and independent recipient settings', async t => {
  const codex = { executable, model: 'test-model', allowEdits: true, windowsSandbox: 'elevated' };
  const { call, workspace, config } = await connect(t, 'to-codex', 2, { codex });
  const args = inspectReply(await call(), 'Claude Code', 'Codex', workspace);
  const prefix = 'mcp_servers.claude_delegate.args=';
  const reverse = JSON.parse(args.find(arg => arg.startsWith(prefix)).slice(prefix.length));
  assert.deepEqual(reverse, [bridgePath, 'to-claude', '--hops', '1', '--config', config, '--workspace', workspace]);
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
