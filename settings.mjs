import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readContext } from './context.mjs';

export const routes = {
  'to-claude': { name: 'claude-local', sender: 'Codex', recipient: 'Claude Code', agent: 'claude', reverse: 'to-codex' },
  'to-codex': { name: 'codex-local', sender: 'Claude Code', recipient: 'Codex', agent: 'codex', reverse: 'to-claude' },
};

export const forwardedVars = [
  'AGENT_BRIDGE_CONTEXT', 'AGENT_BRIDGE_DEPTH', 'AGENT_BRIDGE_CHAIN',
  'AGENT_BRIDGE_WORKSPACE_ROOTS', 'AGENT_BRIDGE_ALLOW_EDITS',
  'AGENT_BRIDGE_ALLOW_CYCLES', 'AGENT_BRIDGE_MAX_CONCURRENT',
  'CLAUDE_BIN', 'CLAUDE_CLI_BIN', 'CODEX_BIN', 'CODEX_CLI_JS',
];

function strictObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object.');
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw new Error('Unknown setting: ' + label + '.' + key);
  }
}

function boolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(label + ' must be a boolean.');
  return value;
}

function positiveInteger(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(label + ' must be a positive integer at most ' + max + '.');
  }
  return value;
}

function recipient(agent, value = {}) {
  const keys = ['executable', 'model', 'allowEdits'];
  if (agent === 'codex') keys.push('windowsSandbox');
  strictObject(value, keys, agent);
  for (const key of ['executable', 'model']) {
    if (key in value && (typeof value[key] !== 'string' || !value[key].length)) {
      throw new Error(agent + '.' + key + ' must be a non-empty string.');
    }
  }
  if ('windowsSandbox' in value && !['mxc', 'elevated', 'unelevated'].includes(value.windowsSandbox)) {
    throw new Error('Invalid codex.windowsSandbox.');
  }
  return { ...value, allowEdits: boolean(value.allowEdits === undefined ? false : value.allowEdits, agent + '.allowEdits') };
}

function validateSettings(value) {
  strictObject(value, ['claude', 'codex', 'timeoutSeconds', 'allowCycles', 'maxConcurrent'], 'settings');
  const { timeoutSeconds = 300, maxConcurrent = 4, allowCycles = false } = value;
  return {
    claude: recipient('claude', value.claude), codex: recipient('codex', value.codex),
    timeoutSeconds: positiveInteger(timeoutSeconds, 'timeoutSeconds', 86400),
    maxConcurrent: positiveInteger(maxConcurrent, 'maxConcurrent'),
    allowCycles: boolean(allowCycles, 'allowCycles'),
  };
}

// node:util.parseArgs first shipped in 18.3. Keep the CLI usable on all of Node 18.
export function readOptions(argv, { allowConfigFile = true, registration = false } = {}) {
  const values = Object.create(null);
  const positionals = [];
  const strings = ['config', 'settings-json', 'bridge-context', 'workspace', 'hops'];
  const flags = registration ? ['allow-cycles', 'status', 'remove'] : ['allow-cycles'];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { positionals.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('-')) { positionals.push(arg); continue; }
    const [, name, inline] = /^--([^=]+)(?:=([\s\S]*))?$/.exec(arg) ?? [];
    if (flags.includes(name) && inline === undefined) values[name] = true;
    else if (strings.includes(name)) {
      if (inline === undefined && (argv[i + 1] === undefined || argv[i + 1].startsWith('-'))) {
        throw new Error('--' + name + ' requires a value.');
      }
      values[name] = inline ?? argv[++i];
    } else throw new Error('Unknown option: ' + arg);
  }
  const [direction] = positionals;
  if (positionals.length !== 1 || !Object.hasOwn(routes, direction)) throw new Error('Choose to-claude or to-codex.');
  const hops = values.hops ?? '1';
  if (!/^[1-9]\d*$/.test(hops)) throw new Error('--hops must be a positive integer.');
  if (values.config !== undefined && values['settings-json'] !== undefined) throw new Error('Choose one settings source.');
  if (values.config !== undefined && !allowConfigFile) {
    throw new Error('This registration still passes --config to the server. Replace it using scripts/register.mjs to save a validated settings snapshot, then restart the host.');
  }
  if (values.remove && values.status) throw new Error('Choose either --status or --remove.');
  const json = values.config === undefined ? values['settings-json'] : readFileSync(resolve(values.config), 'utf8');
  const raw = json === undefined ? {} : JSON.parse(json.replace(/^\uFEFF/, ''));
  const settings = validateSettings(raw);
  if (values['allow-cycles']) settings.allowCycles = true;
  const from = routes[routes[direction].reverse].agent;
  return {
    direction, workspace: values.workspace && resolve(values.workspace), hops: positiveInteger(Number(hops), '--hops'),
    settings, cyclesConfigured: Object.hasOwn(raw, 'allowCycles') || !!values['allow-cycles'],
    bridgeContext: readContext(values['bridge-context'], from),
    ...(registration && { action: values.status ? 'get' : values.remove ? 'remove' : 'add' }),
  };
}

export function serverArgs({ direction, settings, workspace, hops, bridgeContext, cyclesConfigured }) {
  // Keep an explicit cycle denial distinct from the default when the host supplies its environment.
  const snapshot = { ...settings };
  if (cyclesConfigured === false && !settings.allowCycles) delete snapshot.allowCycles;
  const args = [direction, '--hops', String(hops), '--settings-json', JSON.stringify(snapshot)];
  if (settings.allowCycles) args.push('--allow-cycles');
  if (workspace) args.push('--workspace', workspace);
  if (bridgeContext) args.push('--bridge-context', JSON.stringify(bridgeContext));
  return args;
}

export function hostLimits(options, env) {
  const errors = [];
  const cycles = env.AGENT_BRIDGE_ALLOW_CYCLES;
  const cap = env.AGENT_BRIDGE_MAX_CONCURRENT;
  const { allowCycles, maxConcurrent } = options.settings;
  if (cycles !== undefined && cycles !== 'false' && cycles !== 'true') {
    errors.push('AGENT_BRIDGE_ALLOW_CYCLES must be exactly "true" or "false".');
  }
  if (cap !== undefined && (!/^[1-9]\d*$/.test(cap) || !Number.isSafeInteger(Number(cap)))) {
    errors.push('AGENT_BRIDGE_MAX_CONCURRENT must be a positive integer.');
  }
  return {
    allowCycles: !errors.length && (cycles === undefined ? allowCycles : cycles === 'true' && (!options.cyclesConfigured || allowCycles)),
    maxConcurrent: errors.length ? 1 : Math.min(maxConcurrent, cap === undefined ? maxConcurrent : Number(cap)),
    errors,
  };
}
