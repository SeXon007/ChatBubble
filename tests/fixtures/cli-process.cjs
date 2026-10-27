let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: input } }));
  if (process.argv.includes('--hang')) setInterval(() => {}, 1000);
  else if (process.argv.includes('--fail')) process.exitCode = 1;
  else console.log('{"type":"turn.completed"}');
});
