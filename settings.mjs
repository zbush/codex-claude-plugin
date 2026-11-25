import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { readContext } from './context.mjs';

const recipient = z.object({
  executable: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  allowEdits: z.boolean().default(false),
}).strict();

const settingsFile = z.object({
  claude: recipient.default({ allowEdits: false }),
  codex: recipient.extend({
    windowsSandbox: z.enum(['mxc', 'elevated', 'unelevated']).optional(),
  }).default({ allowEdits: false }),
  timeoutSeconds: z.number().int().min(1).max(86400).default(300),
}).strict();

export const routes = {
  'to-claude': { sender: 'Codex', recipient: 'Claude Code', agent: 'claude', reverse: 'to-codex' },
  'to-codex': { sender: 'Claude Code', recipient: 'Codex', agent: 'codex', reverse: 'to-claude' },
};

export function readOptions(argv, { allowConfigFile = true } = {}) {
  const { positionals, values } = parseArgs({
    args: argv, allowPositionals: true,
    options: { config: { type: 'string' }, 'settings-json': { type: 'string' }, 'bridge-context': { type: 'string' },
      workspace: { type: 'string' }, hops: { type: 'string', default: '1' } },
  });
  const [direction] = positionals;
  if (positionals.length !== 1 || !Object.hasOwn(routes, direction)) {
    throw new Error('Choose to-claude or to-codex.');
  }
  if (!/^[1-9]\d*$/.test(values.hops) || !Number.isSafeInteger(Number(values.hops))) {
    throw new Error('--hops must be a positive integer.');
  }
  if (values.config !== undefined && values['settings-json'] !== undefined) {
    throw new Error('Choose one settings source.');
  }
  if (values.config !== undefined && !allowConfigFile) {
    throw new Error('This registration still passes --config to the server. Replace it using scripts/register.mjs to save a validated settings snapshot, then restart the host.');
  }
  const json = values.config === undefined ? values['settings-json'] : readFileSync(resolve(values.config), 'utf8');
  const settings = settingsFile.parse(json === undefined ? {} : JSON.parse(json.replace(/^\uFEFF/, '')));
  const bridgeContext = readContext(values['bridge-context'], routes[direction].agent === 'claude' ? 'codex' : 'claude');
  return { direction, workspace: values.workspace && resolve(values.workspace), hops: Number(values.hops), settings, bridgeContext };
}

export function serverArgs({ direction, settings, workspace, hops, bridgeContext }) {
  // Registrations and reciprocal launches use the policy validated by their caller.
  const args = [direction, '--hops', String(hops), '--settings-json', JSON.stringify(settings)];
  if (workspace) args.push('--workspace', workspace);
  if (bridgeContext) args.push('--bridge-context', JSON.stringify(bridgeContext));
  return args;
}
