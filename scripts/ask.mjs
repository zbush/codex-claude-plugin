import { readFileSync } from 'node:fs';
import { StdioClient } from './stdio-client.mjs';
import { bridgePath } from '../agents.mjs';
import { forwardedVars, readOptions, serverArgs } from '../settings.mjs';

// A real MCP client for a one-shot check of the same server used by both hosts.
const args = process.argv.slice(2);
const options = readOptions(args);
const task = readFileSync(0, 'utf8').trim();
if (!task) throw new Error('Pipe a task to stdin.');
const env = Object.fromEntries(forwardedVars.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
const client = new StdioClient({ command: process.execPath, args: [bridgePath, ...serverArgs(options)], env });
try {
  await client.initialize({ name: 'delegation-smoke-test', version: '2.0.0' });
  const result = await client.callTool({ name: 'delegate', arguments: { task } }, {
    timeout: (options.settings.timeoutSeconds + 10) * 1000,
  });
  console.log(result.content.map(part => part.text).join('\n'));
  if (result.isError) process.exitCode = 1;
} finally {
  await client.close();
}
