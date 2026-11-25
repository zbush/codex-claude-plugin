import { spawnSync } from 'node:child_process';
import { bridgePath } from '../agents.mjs';
import { launcher } from '../run.mjs';
import { forwardedVars, readOptions, routes, serverArgs } from '../settings.mjs';
import { StdioClient } from './stdio-client.mjs';

const options = readOptions(process.argv.slice(2), { registration: true });
const toClaude = options.direction === 'to-claude';
const host = toClaude ? 'codex' : 'claude';
const name = routes[options.direction].name;
const [command, ...prefix] = launcher(host, options.settings[host].executable);
const args = [bridgePath, ...serverArgs(options)];

if (toClaude && options.action === 'add') {
  // Use Codex's TOML writer for one version-checked update, including the forwarding policy.
  const client = new StdioClient({ command, args: [...prefix, 'app-server'], env: process.env, codexAppServer: true });
  try {
    await client.request('initialize', { clientInfo: { name: 'bridge-registration', version: '2.0.0' }, capabilities: {} });
    client.notify('initialized');
    const { layers } = await client.request('config/read', { includeLayers: true });
    const user = layers.find(layer => layer.name.type === 'user' && !layer.name.profile);
    if (!user) throw new Error('Codex did not report its user configuration file.');
    const current = user.config?.mcp_servers?.[name];
    const registration = {
      command: process.execPath, args,
      env_vars: [...new Set([...(current?.env_vars ?? []), ...forwardedVars])],
    };
    const edits = Object.entries(registration).map(([key, value]) => ({
      keyPath: 'mcp_servers.' + name + '.' + key, value, mergeStrategy: 'replace',
    }));
    await client.request('config/batchWrite', { filePath: user.name.file, expectedVersion: user.version, edits });
    console.log('Registered ' + name + ' in ' + user.name.file);
  } finally { await client.close(); }
} else {
  const hostArgs = ['mcp', options.action, name];
  if (!toClaude && options.action !== 'get') hostArgs.push('--scope', 'user');
  if (options.action === 'add') hostArgs.push('--', process.execPath, ...args);
  const result = spawnSync(command, [...prefix, ...hostArgs], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
