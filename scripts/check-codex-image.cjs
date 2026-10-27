// Three short synthetic turns: image input, a second client, and safe continuation.
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { ChatController } = require('../dist/chat');
const { streamCli } = require('../dist/cli');
const { streamCodex, readCodexUpdates, CodexRpc, codexArguments } = require('../dist/codex');
const { initialState, isState } = require('../dist/model');
const { JsonStore } = require('../dist/storage');
const directory = path.resolve(__dirname, '../docs/verification/feature-0.8.0/live');
async function main() {
  await fs.mkdir(directory, { recursive: true });
  const store = new JsonStore(path.join(directory, 'state.json'), isState);
  const existing = await fs.readFile(store.file, 'utf8').then(JSON.parse).catch(() => null);
  if (existing && !process.argv.includes('--continue')) throw new Error('Synthetic live state exists; inspect it before --continue.');
  const settings = JSON.parse(await fs.readFile(path.resolve(__dirname, '../chat/state.json'), 'utf8')).settings;
  const { value: state } = await store.load(initialState);
  Object.assign(state.settings, { provider: 'codex-cli', cliPath: settings.cliPath, cliModel: settings.cliModel, reasoningEffort: 'low', screenCaptureEnabled: true });
  const workDir = path.join(directory, 'workspace'); await fs.mkdir(workDir, { recursive: true });
  let image;
  if (!state.session.messages.length) {
    const folder = path.join(directory, 'attachments'); await fs.mkdir(folder, { recursive: true });
    const file = path.join(folder, randomUUID() + '.png'); await fs.copyFile(path.join(directory, '../synthetic-attachment.png'), file);
    image = { file, capturedAt: new Date().toISOString() };
  }
  const chat = new ChatController(state, store, () => '', () => {}, undefined, options => streamCli({ ...options, workDir }), async () => ({ image }));
  async function send(question) {
    const result = await chat.send(question); if (!result.ok) throw new Error(result.error);
    while (chat.busy) await new Promise(resolve => setTimeout(resolve, 100));
    if (state.session.messages.at(-1).status !== 'complete') throw new Error(state.session.messages.at(-1).error);
    return state.session.messages.at(-1).content;
  }
  if (!state.session.messages.length) {
    const answer = await send('请识别附图中 SCREEN-CODE- 后面的三位数字，只回答数字。不要调用工具。');
    if (!answer.includes('731')) throw new Error('Image recognition did not return the synthetic code.');
  }
  let external = await fs.readFile(path.join(directory, 'external.json'), 'utf8').then(JSON.parse).catch(() => null);
  if (!external) {
    const binding = { ...state.session.codex }; let text = '';
    await streamCodex({ executable: state.settings.cliPath, settings: state.settings, question: '这是另一客户端添加的一轮。请记住代号“松塔482”，只回复“已记住”，不要调用工具。', workDir, signal: new AbortController().signal,
      onChunk: delta => { text += delta; }, conversation: { session: binding, userMessageId: randomUUID(), retry: false, onSession: async () => {}, onTurn: async id => { external = { turnId: id }; await fs.writeFile(path.join(directory, 'external.json'), JSON.stringify(external)); } } });
  }
  if (!state.session.messages.some(message => message.content.includes('松塔482'))) {
    const updates = await readCodexUpdates({ executable: state.settings.cliPath, binding: state.session.codex });
    if (!updates.some(turn => turn.id === external.turnId)) throw new Error('External turn not visible to read-only refresh.');
  }
  if (state.session.messages.length < 6) {
    image = undefined;
    const answer = await send('刚才另一客户端提到的代号是什么？只回复代号，不要调用工具。');
    if (!answer.includes('482')) throw new Error('Continuation failed to recall the other client.');
  }
  const rpc = new CodexRpc({ executable: state.settings.cliPath, args: codexArguments(), cwd: workDir });
  try {
    await rpc.initialize(); await rpc.request('thread/read', { threadId: state.session.codex.threadId });
    const page = await rpc.request('thread/turns/list', { threadId: state.session.codex.threadId, itemsView: 'full', sortDirection: 'asc', limit: 10 });
    const inputs = page.data.flatMap(turn => turn.items.filter(item => item.type === 'userMessage').flatMap(item => item.content));
    const nativeImages = inputs.filter(item => item.type === 'localImage' || item.type === 'image');
    const checks = { imageRecognized: state.session.messages[1].content.includes('731'), nativeImageInHistory: nativeImages.length === 1,
      imageStoredInAttachments: path.dirname(state.session.messages[0].image.file) === path.join(directory, 'attachments'),
      durableAttachmentPresent: await fs.access(state.session.messages[0].image.file).then(() => true, () => false),
      sameThreadThreeTurns: page.data.length === 3, desktopTurnImported: state.session.messages.some(message => message.codexTurnId === external.turnId && message.role === 'assistant'),
      continuedNativeContext: state.session.messages.at(-1).content.includes('482') };
    const report = { date: new Date().toISOString(), threadId: state.session.codex.threadId, model: state.settings.cliModel, checks,
      nativeImageMetadata: nativeImages.map(item => ({ type: item.type, path: item.path, urlKind: item.url?.startsWith('data:') ? 'embedded-data' : item.url ? 'url' : undefined })),
      limitations: ['The other client used a separate real App Server connection, not a mouse-driven desktop handoff', 'Actual Codex desktop image display must be checked separately'] };
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
    if (Object.values(checks).some(value => !value)) throw new Error('Live checks incomplete.');
  } finally { await rpc.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
