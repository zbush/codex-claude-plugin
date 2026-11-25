import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { bridgePath } from '../agents.mjs';
import { readOptions, serverArgs } from '../settings.mjs';

// A real MCP client for a one-shot check of the same server used by both hosts.
const args = process.argv.slice(2);
const options = readOptions(args);
const task = readFileSync(0, 'utf8').trim();
if (!task) throw new Error('Pipe a task to stdin.');
const client = new Client({ name: 'delegation-smoke-test', version: '1.0.0' });
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('AGENT_BRIDGE_')));
const transport = new StdioClientTransport({ command: process.execPath, args: [bridgePath, ...serverArgs(options)], env });
try {
  await client.connect(transport);
  const result = await client.callTool({ name: 'delegate', arguments: { task } }, undefined, {
    timeout: (options.settings.timeoutSeconds + 10) * 1000,
  });
  console.log(result.content.map(part => part.text).join('\n'));
  if (result.isError) process.exitCode = 1;
} finally {
  await client.close();
}
