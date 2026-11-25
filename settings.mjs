import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';

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

export function readOptions(argv) {
  const { positionals, values } = parseArgs({
    args: argv, allowPositionals: true,
    options: { config: { type: 'string' }, workspace: { type: 'string' }, hops: { type: 'string', default: '1' } },
  });
  const [direction] = positionals;
  if (positionals.length !== 1 || !Object.hasOwn(routes, direction)) {
    throw new Error('Choose to-claude or to-codex.');
  }
  if (!/^[1-9]\d*$/.test(values.hops) || !Number.isSafeInteger(Number(values.hops))) {
    throw new Error('--hops must be a positive integer.');
  }
  const config = values.config && resolve(values.config);
  const settings = settingsFile.parse(config ? JSON.parse(readFileSync(config, 'utf8').replace(/^\uFEFF/, '')) : {});
  return { direction, config, workspace: values.workspace && resolve(values.workspace), hops: Number(values.hops), settings };
}

export function serverArgs({ direction, config, workspace, hops }) {
  const args = [direction, '--hops', String(hops)];
  if (config) args.push('--config', config);
  if (workspace) args.push('--workspace', workspace);
  return args;
}
