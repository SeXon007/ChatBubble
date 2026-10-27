const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const readline = require('node:readline');
const file = path.join(process.cwd(), 'native-fixture.json');
const load = () => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { threads: {}, starts: 0, requests: [] };
const write = value => fs.writeFileSync(file, JSON.stringify(value));
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const event = (method, params) => emit({ method, params });
let active;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const q = JSON.parse(line), data = load();
  if (!q.method) return;
  data.requests.push(q); write(data);
  const reply = result => emit({ id: q.id, result });
  const error = () => emit({ id: q.id, error: { code: -1, message: 'test secret must not leak' } });
  const p = q.params;
  switch (q.method) {
    case 'initialize': return reply({});
    case 'initialized': return;
    case 'config/read': {
      const name = process.env.CHATBUBBLE_FIXTURE_MCP;
      return reply({ config: { mcp_servers: name ? { [name]: { enabled: !process.argv.includes('mcp_servers.' + name + '.enabled=false') } } : {} } });
    }
    case 'thread/start': {
      const thread = { id: randomUUID(), ephemeral: p.ephemeral, cwd: p.cwd, turns: [], status: { type: 'idle' } };
      data.threads[thread.id] = thread; write(data); return reply({ thread });
    }
    case 'thread/resume': {
      if (data.locked) return emit({ id: q.id, error: { code: -32000, message: 'thread already open in another application' } });
      const thread = data.threads[p.threadId]; return thread ? reply({ thread }) : emit({ id: q.id, error: { code: -1, message: 'no rollout found for thread' } });
    }
    case 'thread/read': return reply({ thread: data.threads[p.threadId] });
    case 'thread/turns/list': {
      const all = data.threads[p.threadId].turns.slice(); if (p.sortDirection !== 'asc') all.reverse();
      const start = Number(p.cursor ?? 0), end = start + p.limit;
      return reply({ data: all.slice(start, end), nextCursor: end < all.length ? String(end) : null });
    }
    case 'thread/revert': {
      const thread = data.threads[p.threadId]; thread.turns = thread.turns.slice(0, thread.turns.findIndex(t => t.id === p.beforeTurnId)); write(data); return reply({ thread });
    }
    case 'turn/interrupt': {
      if (!active) return error();
      const turn = data.threads[p.threadId].turns.at(-1); turn.status = 'interrupted'; write(data); reply({});
      event('turn/completed', { threadId: p.threadId, turn }); active = undefined; return;
    }
    case 'turn/start': {
      const text = p.input[0].text;
      const turn = { id: randomUUID(), status: 'inProgress', items: [{ id: randomUUID(), type: 'userMessage', content: p.input }] };
      const item = { id: randomUUID(), type: 'agentMessage', text: text.includes('[fail]') ? '部分' : '你好' };
      turn.items.push(item); data.threads[p.threadId].turns.push(turn); data.starts++; write(data);
      reply({ turn }); event('turn/started', { threadId: p.threadId, turn });
      const envelope = { threadId: p.threadId, turnId: turn.id };
      event('item/started', { ...envelope, item: { ...item, text: '' } });
      if (text.includes('[tool]')) { event('item/started', { ...envelope, item: { id: randomUUID(), type: 'commandExecution' } }); return; }
      event('item/agentMessage/delta', { ...envelope, itemId: item.id, delta: item.text.slice(0, 1) });
      event('item/agentMessage/delta', { ...envelope, itemId: item.id, delta: item.text.slice(1) });
      if (text.includes('[hang]')) { active = turn.id; return; }
      if (text.includes('[crash]')) return process.exit(3);
      turn.status = text.includes('[fail]') ? 'failed' : 'completed';
      data.threads[p.threadId].turns[data.threads[p.threadId].turns.length - 1] = turn; write(data);
      event('item/completed', { ...envelope, item }); event('turn/completed', { threadId: p.threadId, turn }); return;
    }
    default: return error();
  }
});
