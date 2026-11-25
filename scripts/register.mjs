import { spawnSync } from 'node:child_process';
import { bridgePath } from '../agents.mjs';
import { launcher } from '../run.mjs';
import { readOptions, serverArgs } from '../settings.mjs';

const options = readOptions(process.argv.slice(2));
const toClaude = options.direction === 'to-claude';
const host = toClaude ? 'codex' : 'claude';
const [command, ...prefix] = launcher(host, options.settings[host].executable);
const args = toClaude
  ? ['mcp', 'add', 'claude_delegate']
  : ['mcp', 'add', '--scope', 'user', 'codex_delegate'];
const result = spawnSync(command, [
  ...prefix, ...args, '--', process.execPath, bridgePath, ...serverArgs(options),
], { stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
