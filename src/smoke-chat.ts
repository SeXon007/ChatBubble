import { createServer } from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { dialog, shell, type BrowserWindow } from 'electron';
import type { ChatController } from './chat';
import { isState, type SavedState } from './model';
import { JsonStore } from './storage';
import { Vault } from './vault';
import { ChatStorage } from './chat-storage';

export async function smokeChat(options: {
  window: BrowserWindow; settingsWindow: () => BrowserWindow | null; openSettings: () => Promise<void>;
  state: SavedState; chat: ChatController; storage: ChatStorage; dataDir: string; artifactDir: string;
  setMode: (mode: 'expanded' | 'hidden') => void; broadcast: () => void;
  check: (name: string, ok: boolean) => void;
}): Promise<void> {
  const { window, state, chat, check } = options;
  const requests: { model: string; messages: { role: string; content: string }[] }[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'local-protocol-test' }] })); return;
    }
    let body = ''; for await (const chunk of request) body += chunk.toString();
    requests.push(JSON.parse(body));
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const answer = requests.length === 1 ? '已记住：猫叫圆圆。\n\n- 第一项\n- 第二项\n\n安全代码\n<script>window.pwned=true</script>' : '你的猫叫圆圆。';
    response.write('data: ' + JSON.stringify({ choices: [{ delta: { content: answer } }] }) + '\n\n');
    setTimeout(() => response.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'), 100);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const waitUntil = async (condition: () => Promise<boolean> | boolean): Promise<void> => {
    const deadline = Date.now() + 12000;
    while (!await condition()) { if (Date.now() > deadline) throw new Error('Smoke timeout'); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  try {
    await options.openSettings();
    const settingsWindow = options.settingsWindow()!;
    await waitUntil(() => settingsWindow.webContents.executeJavaScript("!document.querySelector('#provider').disabled"));
    const settings = { baseUrl: 'http://127.0.0.1:' + port + '/v1', model: 'local-protocol-test', key: 'smoke-only-not-real-key' };
    const filled = await settingsWindow.webContents.executeJavaScript('(() => { const values=' + JSON.stringify(settings) + ';for(const [id,value] of Object.entries(values)){const e=document.getElementById(id);e.value=value;e.dispatchEvent(new Event("input"));}document.querySelector("#key").dispatchEvent(new Event("blur"));return window.flushSettings();})()');
    check('settings-autosave-and-vault', filled && state.settings.baseUrl === settings.baseUrl && state.settings.model === settings.model);
    check('compact-settings-tabs-without-accordions-or-save-button', await settingsWindow.webContents.executeJavaScript("!document.querySelector('button[type=submit],details,#contextBudget') && document.querySelectorAll('[role=tab]').length===4 && document.querySelector('#appearance').hidden && document.documentElement.clientWidth>=360"));
    check('connection-settings-row-order', await settingsWindow.webContents.executeJavaScript("Array.from(document.querySelectorAll('#connection>.row')).filter(e=>e.getClientRects().length).map(e=>e.querySelector('label').textContent).join('|')==='连接方式|服务商|服务地址|API Key|模型'"));
    const credentialText = await readFile(path.join(options.dataDir, 'credentials.json'), 'utf8');
    check('key-not-plaintext', !credentialText.includes(settings.key) && !(await readFile(path.join(options.dataDir, 'state.json'), 'utf8')).includes(settings.key));
    const reopenedVault = new Vault(path.join(options.dataDir, 'credentials.json')); await reopenedVault.load();
    check('key-decrypt-and-endpoint-bound', reopenedVault.forEndpoint(settings.baseUrl) === settings.key && reopenedVault.forEndpoint('https://other.test') === '');
    check('key-not-returned-to-renderer', await window.webContents.executeJavaScript('window.desktop.getState().then(s => s.hasKey && !JSON.stringify(s).includes(' + JSON.stringify(settings.key) + '))'));
    await settingsWindow.webContents.executeJavaScript('document.querySelector("#baseUrl").value=' + JSON.stringify(settings.baseUrl + '/other') + ';document.querySelector("#baseUrl").dispatchEvent(new Event("input"));window.flushSettings()');
    check('new-endpoint-never-reuses-old-key', await settingsWindow.webContents.executeJavaScript('window.desktop.getState().then(s=>!s.hasKey)'));
    await settingsWindow.webContents.executeJavaScript('document.querySelector("#baseUrl").value=' + JSON.stringify(settings.baseUrl) + ';document.querySelector("#baseUrl").dispatchEvent(new Event("input"));window.flushSettings()');
    check('stale-key-write-rejected', await settingsWindow.webContents.executeJavaScript('window.desktop.saveSettings({key:"stale-not-real",keyEndpoint:"https://different.test"}).then(r=>!r.ok)'));
    await settingsWindow.webContents.executeJavaScript("document.querySelector('#model').dispatchEvent(new Event('compositionstart'));document.querySelector('#model').value='正在选词';document.querySelector('#model').dispatchEvent(new Event('input'))");
    await new Promise(resolve => setTimeout(resolve, 420));
    check('settings-ime-composition-not-prematurely-saved', state.settings.model === settings.model);
    await settingsWindow.webContents.executeJavaScript("document.querySelector('#model').dispatchEvent(new Event('compositionend'));window.flushSettings()");
    await settingsWindow.webContents.executeJavaScript("document.querySelector('#model').value='debounced-test';document.querySelector('#model').dispatchEvent(new Event('input'))");
    await waitUntil(() => state.settings.model === 'debounced-test');
    check('text-stops-typing-autosaves-without-button', true);
    await settingsWindow.webContents.executeJavaScript("document.querySelector('#baseUrl').value='invalid address';document.querySelector('#baseUrl').dispatchEvent(new Event('input'))");
    check('invalid-address-keeps-last-valid-value', !await settingsWindow.webContents.executeJavaScript('window.flushSettings()') && state.settings.baseUrl === settings.baseUrl);
    await window.webContents.executeJavaScript("window.desktop.saveDraft('状态回送不应覆盖编辑')");
    check('state-echo-does-not-overwrite-pending-edit', await settingsWindow.webContents.executeJavaScript("document.querySelector('#baseUrl').value==='invalid address'"));
    await settingsWindow.webContents.executeJavaScript('document.querySelector("#baseUrl").value=' + JSON.stringify(settings.baseUrl) + ';document.querySelector("#baseUrl").dispatchEvent(new Event("input"));window.flushSettings()');
    const compactHeight = settingsWindow.getContentSize()[1]!;
    await settingsWindow.webContents.executeJavaScript("document.querySelector('#tab-appearance').click();for(const value of ['12','20','14']){document.querySelector('#fontSize').value=value;document.querySelector('#fontSize').dispatchEvent(new Event('change'));}window.flushSettings()");
    await waitUntil(() => settingsWindow.getContentSize()[1]! < compactHeight);
    check('tab-switch-resizes-to-current-panel', await settingsWindow.webContents.executeJavaScript("document.querySelectorAll('[role=tabpanel]:not([hidden])').length===1 && !document.querySelector('#appearance').hidden"));
    check('rapid-autosaves-retain-latest-choice', state.settings.fontSize === 14 && (await options.storage.load()).value.settings.fontSize === 14);
    await settingsWindow.webContents.executeJavaScript("document.querySelector('#tab-connection').click()");
    await window.webContents.executeJavaScript("document.querySelector('#input').value='记住我的猫叫圆圆'; document.querySelector('#composer').dispatchEvent(new Event('submit', {bubbles:true,cancelable:true}));");
    await waitUntil(() => chat.busy); options.setMode('hidden'); await waitUntil(() => !chat.busy);
    check('stream-completes-while-hidden', state.session.messages.at(-1)?.status === 'complete' && !window.isVisible());
    options.setMode('expanded');
    await waitUntil(() => window.webContents.executeJavaScript("document.querySelectorAll('.message').length === 2"));
    check('safe-markdown-rendering', await window.webContents.executeJavaScript("!window.pwned && document.querySelectorAll('#messages script').length===0 && document.querySelectorAll('#messages li').length===2 && document.querySelector('#messages').textContent.includes('<script>')"));
    await window.webContents.executeJavaScript("window.desktop.submit('我的猫叫什么？')"); await waitUntil(() => !chat.busy);
    check('real-http-context-roundtrip', requests.length === 2 && requests[1]!.messages.some(m => m.role === 'user' && m.content.includes('记住我的猫')) && requests[1]!.messages.some(m => m.role === 'assistant' && m.content.includes('已记住')));
    await window.webContents.executeJavaScript("document.querySelector('#input').value='重启后应恢复的草稿';window.desktop.saveDraft('重启后应恢复的草稿')");
    await chat.persist();
    const reopened = await new JsonStore(path.join(options.dataDir, 'state.json'), isState).load(() => { throw new Error('Missing state'); });
    check('session-draft-disk-roundtrip', reopened.value.session.draft === '重启后应恢复的草稿' && reopened.value.session.messages.length === 4);
    await window.loadFile(path.join(__dirname, 'ui/index.html')); options.setMode('expanded');
    await waitUntil(() => window.webContents.executeJavaScript("document.querySelector('#input').value==='重启后应恢复的草稿' && document.querySelectorAll('.message').length===4"));
    check('renderer-reload-restores-session', true);
    await settingsWindow.webContents.executeJavaScript("document.querySelector('#model').value='fresh-check-model';document.querySelector('#model').dispatchEvent(new Event('input'));document.querySelector('#check').click()");
    await waitUntil(() => settingsWindow.webContents.executeJavaScript("document.querySelector('#result').textContent==='连接成功'"));
    check('connection-check-flushes-latest-edit-and-excludes-history', requests.length === 3 && requests[2]!.model === 'fresh-check-model' && requests[2]!.messages.length === 1 && requests[2]!.messages[0]!.content === '请只回复 OK。');
    check('settings-only-history-bridge', await window.webContents.executeJavaScript('window.desktop.listArchives().then(() => false, () => true)'));
    const archivedState = structuredClone(state); archivedState.session.id = 'smoke-historical'; archivedState.session.draft = '历史草稿'; archivedState.session.messages = archivedState.session.messages.slice(0, 2);
    const archivedId = await options.storage.archive(archivedState);
    await settingsWindow.webContents.executeJavaScript("document.querySelector('#history').click()");
    await waitUntil(() => settingsWindow.webContents.executeJavaScript("document.querySelector('#archive-list').options.length===2"));
    await settingsWindow.webContents.executeJavaScript('document.querySelector("#archive-list").value=' + JSON.stringify(archivedId) + ';document.querySelector("#archive-list").dispatchEvent(new Event("change"))');
    await waitUntil(() => settingsWindow.webContents.executeJavaScript("document.querySelector('#archive-messages').textContent.includes('<script>')"));
    check('archive-preview-safe-text', await settingsWindow.webContents.executeJavaScript("!window.pwned && !document.querySelector('#archive-messages script')"));
    const oldSessionId = state.session.id, oldSettings = JSON.stringify(state.settings), originalMessageBox = dialog.showMessageBox;
    try {
      dialog.showMessageBox = (async () => ({ response: 0, checkboxChecked: false })) as typeof dialog.showMessageBox;
      check('archive-restore-cancel-preserves-current', await settingsWindow.webContents.executeJavaScript('window.desktop.restoreArchive(' + JSON.stringify(archivedId) + ').then(r => !!r.cancelled)') && state.session.id === oldSessionId);
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
      await settingsWindow.webContents.executeJavaScript("document.querySelector('#restore-archive').click()");
      await waitUntil(() => state.session.id !== oldSessionId && state.session.draft === '历史草稿');
      await waitUntil(() => settingsWindow.webContents.executeJavaScript("!document.querySelector('#history-dialog').open"));
    } finally { dialog.showMessageBox = originalMessageBox; }
    let currentArchived = false;
    for (const item of (await options.storage.list()).items) if ((await options.storage.readArchive(item.id)).id === oldSessionId) currentArchived = true;
    check('archive-restore-backs-up-current-and-keeps-settings', currentArchived && JSON.stringify(state.settings) === oldSettings && requests.length === 3 && !chat.busy);
    await waitUntil(() => window.webContents.executeJavaScript("document.querySelector('#input').value==='历史草稿' && document.querySelectorAll('.message').length===2"));
    const relocated = await mkdtemp(path.join(os.tmpdir(), 'chatbubble-relocated-')), originalDirectoryDialog = dialog.showOpenDialog;
    try {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [relocated] })) as typeof dialog.showOpenDialog;
      await settingsWindow.webContents.executeJavaScript("document.querySelector('#choose-storage').click()");
      await waitUntil(() => options.storage.directory === relocated);
      await waitUntil(() => settingsWindow.webContents.executeJavaScript("document.querySelector('#result').textContent==='存储位置已更新'"));
      check('settings-directory-picker-migrates-data', true);
    } finally { dialog.showOpenDialog = originalDirectoryDialog; }
    await window.webContents.executeJavaScript("window.desktop.saveDraft('切换目录后的草稿')"); await chat.persist();
    const migrated = await ChatStorage.open(options.dataDir);
    check('custom-location-reopens-and-continues-saving', migrated.directory === relocated && (await migrated.load()).value.session.draft === '切换目录后的草稿' && (await migrated.list()).items.length === 2);
    check('migration-keeps-original-backup', JSON.parse(await readFile(path.join(options.dataDir, 'state.json'), 'utf8')).session.draft === '历史草稿');
    const originalSave = options.storage.save;
    try {
      options.storage.save = async () => { throw new Error('Injected disk failure'); };
      await settingsWindow.webContents.executeJavaScript("document.querySelector('#fontSize').value='16';document.querySelector('#fontSize').dispatchEvent(new Event('change'));window.flushSettings()");
      check('autosave-failure-preserves-valid-config-and-shows-error', state.settings.fontSize === 14 && await settingsWindow.webContents.executeJavaScript("document.querySelector('#result').dataset.error==='true' && document.querySelector('#fontSize').value==='16'"));
    } finally { options.storage.save = originalSave; }
    await settingsWindow.webContents.executeJavaScript("document.querySelector('#fontSize').value='14';document.querySelector('#fontSize').dispatchEvent(new Event('change'));window.flushSettings()");
    check('failed-autosave-can-be-corrected', !chat.warning && state.settings.fontSize === 14);
    settingsWindow.focus(); await new Promise(resolve => setTimeout(resolve, 200));
    await writeFile(path.join(options.artifactDir, 'settings-api-render.png'), (await settingsWindow.webContents.capturePage()).toPNG());
    const detected = await settingsWindow.webContents.executeJavaScript('window.desktop.discoverCli()') as { kind: string; path: string; usable: boolean }[];
    const cli = detected.find(c => c.usable && c.kind === 'codex-cli') || detected.find(c => c.usable);
    if (cli) {
      await settingsWindow.webContents.executeJavaScript('document.querySelector("#provider").value=' + JSON.stringify(cli.kind) + ';document.querySelector("#provider").dispatchEvent(new Event("change"));window.flushSettings()');
      check('cli-provider-choice-autosaves-and-preserves-other-fields', state.settings.provider === cli.kind && state.settings.cliPath === cli.path && state.settings.baseUrl === settings.baseUrl);
      if (cli.kind === 'codex-cli') check('codex-visible-row-order', await settingsWindow.webContents.executeJavaScript("Array.from(document.querySelectorAll('#connection>.row')).filter(e=>e.getClientRects().length).map(e=>e.querySelector('label').textContent).join('|')==='连接方式|程序路径|模型|推理强度'"));
      if (cli.kind === 'codex-cli') {
        const model = (await settingsWindow.webContents.executeJavaScript('window.desktop.getModelCatalog()')).models[0];
        if (model) {
          await settingsWindow.webContents.executeJavaScript('document.querySelector("#cli-model-choice").value=' + JSON.stringify(model.id) + ';document.querySelector("#cli-model-choice").dispatchEvent(new Event("change"));document.querySelector("#reasoningEffort").value=' + JSON.stringify(model.efforts.includes('high') ? 'high' : model.efforts[0] || '') + ';document.querySelector("#reasoningEffort").dispatchEvent(new Event("change"));window.flushSettings()');
          check('model-and-effort-selection-autosave', (await migrated.load()).value.settings.cliModel === model.id && !!state.settings.reasoningEffort);
        }
      }
      const picker = dialog.showOpenDialog;
      try {
        await settingsWindow.webContents.executeJavaScript("document.querySelector('#cliPath').value='invalid path';document.querySelector('#cliPath').dispatchEvent(new Event('input'));window.flushSettings()");
        check('invalid-path-preserves-saved-path', state.settings.cliPath === cli.path);
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [cli.path] })) as typeof dialog.showOpenDialog;
        await settingsWindow.webContents.executeJavaScript("document.querySelector('#pick-cli').click()");
        await waitUntil(() => settingsWindow.webContents.executeJavaScript("document.querySelector('#result').dataset.error==='false' && !document.querySelector('#pick-cli').disabled"));
        check('native-file-picker-corrects-invalid-edit-and-autosaves', await settingsWindow.webContents.executeJavaScript('document.querySelector("#cliPath").value===' + JSON.stringify(cli.path)));
      } finally { dialog.showOpenDialog = picker; }
    }
    check('native-history-link-is-settings-only', await window.webContents.executeJavaScript('window.desktop.openCodex().then(() => false, () => true)'));
    const originalNative = state.session.codex, originalOpen = shell.openExternal, originalProvider = state.settings.provider;
    const testId = '11111111-1111-4111-8111-111111111111'; let openedUrl = '';
    try {
      state.session.codex = { threadId: testId, home: options.dataDir, cwd: options.dataDir };
      state.settings.provider = 'codex-cli';
      shell.openExternal = (async url => { openedUrl = url; }) as typeof shell.openExternal;
      options.broadcast();
      await waitUntil(() => settingsWindow.webContents.executeJavaScript("!document.querySelector('#open-codex').hidden"));
      check('native-history-link-opens-only-owned-id', await settingsWindow.webContents.executeJavaScript('window.desktop.openCodex().then(r=>r.ok)') && openedUrl === 'codex://threads/' + testId);
      await settingsWindow.webContents.executeJavaScript("document.querySelector('#history').click()");
      await new Promise(resolve => setTimeout(resolve, 200));
      await writeFile(path.join(options.artifactDir, 'history-settings-render.png'), (await settingsWindow.webContents.capturePage()).toPNG());
      await settingsWindow.webContents.executeJavaScript("document.querySelector('#close-history').click()");
    } finally { state.session.codex = originalNative; state.settings.provider = originalProvider; shell.openExternal = originalOpen; options.broadcast(); }
    await new Promise(resolve => setTimeout(resolve, 200));
    await writeFile(path.join(options.artifactDir, 'settings-render.png'), (await settingsWindow.webContents.capturePage()).toPNG());
    await writeFile(path.join(options.artifactDir, 'chat-render.png'), (await window.webContents.capturePage()).toPNG());
    const pendingField = cli ? 'cliModel' : 'model';
    if (cli?.kind === 'codex-cli') await settingsWindow.webContents.executeJavaScript("document.querySelector('#cli-model-choice').value='__custom__';document.querySelector('#cli-model-choice').dispatchEvent(new Event('change'))");
    await settingsWindow.webContents.executeJavaScript('document.getElementById(' + JSON.stringify(pendingField) + ').value="close-flush-test";document.getElementById(' + JSON.stringify(pendingField) + ').dispatchEvent(new Event("input"))');
    settingsWindow.close();
    await waitUntil(() => options.settingsWindow() === null);
    check('closing-settings-flushes-last-text-before-debounce', (await migrated.load()).value.settings[pendingField] === 'close-flush-test');
    await options.openSettings(); const reopenedSettings = options.settingsWindow()!;
    await waitUntil(() => reopenedSettings.webContents.executeJavaScript("!document.querySelector('#provider').disabled"));
    check('reopened-settings-read-the-same-config', await reopenedSettings.webContents.executeJavaScript('document.getElementById(' + JSON.stringify(pendingField) + ').value==="close-flush-test"'));
    reopenedSettings.close(); await waitUntil(() => options.settingsWindow() === null);
    const previousMessages = structuredClone(state.session.messages), previousCodex = state.session.codex;
    try {
      state.session.codex = { threadId: randomUUID(), home: options.dataDir, cwd: options.dataDir, lastTurnId: randomUUID() };
      await chat.synchronize(async () => [{ id: randomUUID(), status: 'completed', user: '桌面同步问题', assistant: '桌面同步回答' }]);
      state.session.messages.at(-2)!.image = { file: path.join(options.dataDir, 'synthetic-hidden-image.png'), capturedAt: new Date().toISOString() };
      options.broadcast();
      await waitUntil(() => window.webContents.executeJavaScript("Array.from(document.querySelectorAll('#messages .message')).at(-1)?.textContent==='桌面同步回答'"));
      check('desktop-import-appears-in-message-order', await window.webContents.executeJavaScript("Array.from(document.querySelectorAll('#messages .message')).slice(-2).map(e=>e.textContent).join('|')==='桌面同步问题|桌面同步回答'"));
      check('native-image-not-rendered-in-chatbubble', await window.webContents.executeJavaScript("!document.querySelector('#messages img,#composer img') && !document.querySelector('#messages').textContent.includes('synthetic-hidden-image')"));
    } finally { state.session.messages = previousMessages; state.session.codex = previousCodex; await chat.persist(); options.broadcast(); }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
