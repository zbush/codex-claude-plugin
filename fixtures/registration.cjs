const { writeFileSync } = require('node:fs');
const { createInterface } = require('node:readline');

const args = process.argv.slice(2);
if (args[0] === 'app-server') {
  createInterface({ input: process.stdin }).on('line', line => {
    const { id, method, params } = JSON.parse(line);
    if (id === undefined) return;
    let result = {};
    if (method === 'config/read') {
      result.layers = [{
        name: { type: 'user', file: 'config.toml' }, version: 'initial',
        config: { mcp_servers: { 'claude-local': { env_vars: ['KEEP', 'CLAUDE_BIN'] } } },
      }];
    } else if (method === 'config/batchWrite') {
      writeFileSync(process.env.REGISTRATION_RECORD, JSON.stringify(params));
    }
    console.log(JSON.stringify({ id, result }));
  });
} else {
  writeFileSync(process.env.REGISTRATION_RECORD, JSON.stringify(args));
}
