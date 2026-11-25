import { readFileSync } from 'node:fs';
import { AgentExecutionError, delegate, status } from './agents.mjs';
import { invalidParams, serve } from './mcp.mjs';
import { hostLimits, readOptions, routes } from './settings.mjs';

const options = readOptions(process.argv.slice(2), { allowConfigFile: false });
options.workspace ??= process.cwd();
const route = routes[options.direction];
const serverInfo = { name: route.name, version: '2.0.0' };
try {
  const icon = readFileSync(new URL('./assets/icon-64.png', import.meta.url), 'base64');
  serverInfo.icons = [{ src: 'data:image/png;base64,' + icon, mimeType: 'image/png', sizes: ['64x64'] }];
} catch { /* The icon is optional in standalone installations. */ }

const maxLength = 100_000;
const tools = [
  {
    name: 'delegate',
    description: 'Delegate a self-contained task from ' + route.sender + ' to a fresh ' + route.recipient +
      ' session in ' + options.workspace + '. Context comes from the sending agent. Return its attributed reply.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['task'],
      properties: {
        task: { type: 'string', minLength: 1, maxLength, description: 'Work to perform and the expected result.' },
        context: { type: 'string', maxLength, description: 'Relevant facts or excerpts for the recipient.' },
      },
    },
  },
  {
    name: 'status', description: 'Inspect the bridge configuration, policy and in-flight delegations.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
];

let activeCalls = 0;
const { maxConcurrent } = hostLimits(options, process.env);
async function callTool(name, args, controller) {
  if (name === 'status') {
    if (Object.keys(args).length) throw invalidParams('status takes no arguments.');
    const report = status(options, activeCalls);
    return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }], structuredContent: report };
  }
  const { task, context } = args;
  if (Object.keys(args).some(key => key !== 'task' && key !== 'context') ||
      typeof task !== 'string' || !task.trim() || task.length > maxLength ||
      (context !== undefined && (typeof context !== 'string' || context.length > maxLength))) {
    throw invalidParams('delegate requires a non-empty task and accepts optional string context (100000 characters each).');
  }
  if (activeCalls >= maxConcurrent) {
    throw invalidParams('Maximum concurrent delegations reached.', 'max_concurrent_reached');
  }
  activeCalls++;
  const timer = setTimeout(() => controller.abort(), options.settings.timeoutSeconds * 1000);
  try {
    const text = await delegate(options, { task: task.trim(), context }, controller.signal);
    return { content: [{ type: 'text', text }] };
  } catch (error) {
    if (!(error instanceof AgentExecutionError)) throw error;
    return { isError: true, content: [{ type: 'text', text: 'Delegation to ' + route.recipient + ' failed: ' + error.message }] };
  } finally {
    clearTimeout(timer);
    activeCalls--;
  }
}

serve({ serverInfo, tools, callTool });
