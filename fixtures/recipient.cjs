// A CLI stand-in. The test inspects exactly what crossed the process boundary.
const { readFileSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
const input = readFileSync(0, 'utf8');
const call = JSON.parse(input.trim().split('\n').at(-1));
const reply = JSON.stringify({ args, input, cwd: process.cwd() });
if (call.task === 'timeout') {
  setTimeout(() => process.exit(2), 60000);
} else if (args.includes('exec')) {
  const out = args[args.indexOf('--output-last-message') + 1];
  if (call.task !== 'missing') writeFileSync(out, reply);
  console.log('progress that should never become the answer');
  if (call.task === 'failure') process.exitCode = 2;
} else {
  console.log(JSON.stringify({ is_error: call.task === 'failure', result: reply }));
}
