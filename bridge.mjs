import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { delegate } from './agents.mjs';
import { readOptions, routes } from './settings.mjs';

const options = readOptions(process.argv.slice(2), { allowConfigFile: false });
options.workspace ??= process.cwd();
const route = routes[options.direction];
const server = new McpServer({ name: options.direction, version: '1.0.0' });
const shutdown = new AbortController();

server.registerTool('delegate', {
  description: `Delegate a self-contained task from ${route.sender} to a fresh ${route.recipient} session in ${options.workspace}. Context comes from the sending agent. Return its attributed reply.`,
  inputSchema: {
    task: z.string().trim().min(1).max(100000).describe('Work to perform and the expected result.'),
    context: z.string().max(100000).optional().describe('Relevant facts or excerpts to relay to the recipient.'),
  },
}, async (input, request) => {
  const deadline = AbortSignal.timeout(options.settings.timeoutSeconds * 1000);
  const signal = AbortSignal.any([request.signal, shutdown.signal, deadline]);
  try {
    const text = await delegate(options, input, signal);
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: `Delegation to ${route.recipient} failed: ${error.message}` }] };
  }
});

function close() {
  shutdown.abort();
  void server.close();
}
process.stdin.once('end', close);
process.once('SIGINT', close);
process.once('SIGTERM', close);
await server.connect(new StdioServerTransport());
