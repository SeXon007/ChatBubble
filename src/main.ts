import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeImage, net, screen, shell, Tray } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { clampBounds, canSubmit, Rect, WindowMode } from './window-state';
import { newSession, SavedState } from './model';
import { conversationSource, prepareConversation, recordedSource } from './conversation-source';
import { Vault } from './vault';
import { ChatController } from './chat';
import { endpoint, streamChat } from './provider';
import { smokeChat } from './smoke-chat';
import { discoverCli, inspectCli, streamCli } from './cli';
import { ChatStorage } from './chat-storage';
import { readModelCatalog } from './cli-models';
import { persistSettingsPatch } from './settings';
import { desktopBounds, isPetPosition, petOptions, placePet, shapeRegions, type DesktopArea, type DesktopScene } from './pet-state';
import { ScreenCapture, migrateScreenshots } from './screen-capture';
import { WindowCapture } from './windows-capture';
import { readCodexUpdates } from './codex';
import { apiPresets, listApiModels } from './api-models';
import { captureCapability } from './api-capabilities';
import { apiDesktopClient, desktopClientName, locateDesktopClient, clientNotFound, localApiHistoryNotice } from './desktop-client';
import { Updates, prepareUpdate, launchUpdate } from './updates';
import { updateFetch } from './update-fetch';

let window: BrowserWindow;
let tray: Tray;
let mode: WindowMode = 'expanded';
let modeApplied = false;
let expandedBounds: Rect;
let workAreas: DesktopArea[] = [];
let pointerTimer: ReturnType<typeof setInterval> | undefined;
let inputRegions: Rect[] = [];
let nativePaintRegions: Rect[] = [];
let petDragging = false;
let ignoringMouse = true;
let nativeShape = '';
let quitting = false;
const smoke = process.argv.includes('--smoke-test');
const restartMode = process.argv.find(arg => ['--restart-seed', '--restart-verify', '--restart-secondary'].includes(arg));
const page = path.join(__dirname, 'ui/index.html');
const settingsPage = path.join(__dirname, 'ui/settings.html');
const appIcon = path.join(__dirname, 'assets/app.ico');
if (restartMode) {
  const testData = process.env.CHATBUBBLE_RESTART_DATA;
  if (!testData || path.dirname(path.resolve(testData)) !== path.resolve(os.tmpdir()) || !path.basename(testData).startsWith('chatbubble-restart-')) throw new Error('Restart tests require an isolated temp directory.');
  app.setPath('userData', testData);
}
else if (smoke) app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'chatbubble-smoke-')));
else app.setPath('userData', path.join(app.getPath('appData'), 'ChatBubble'));
let settingsWindow: BrowserWindow | null = null;
let settingsManuallySized = false;
let state: SavedState;
let store: ChatStorage;
let vault: Vault;
let chat: ChatController;
let screenCapture: ScreenCapture;
let nativeCapture: WindowCapture | undefined;
let historyRefresh: Promise<void> | undefined;
let recoveryWarning = '';
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let checking = false;
let configuring = false;
let closing = false;
let flushingSettings = false;
let settingsFlush: Promise<boolean> | undefined;
const fetcher: typeof fetch = (input, init) => net.fetch(input as string, init);
let pendingUpdateLaunch: string | undefined;
const updateHelper = path.join(__dirname, 'native/install-update.ps1');
const updates = new Updates({ version: app.getVersion(), cache: path.join(app.getPath('userData'), 'updates'), fetcher: updateFetch,
  changed: () => { if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('app:update:state', updates.state); },
  prepare: (candidate, zip, folder) => {
    const parent = path.dirname(path.dirname(process.execPath));
    return prepareUpdate({ candidate, zip, folder, executable: process.execPath, helper: updateHelper,
      shortcuts: [path.join(parent, '启动 ChatBubble.lnk'), path.join(path.dirname(parent), '启动 ChatBubble.lnk'),
        path.join(app.getPath('desktop'), 'ChatBubble.lnk'), path.join(app.getPath('desktop'), '启动 ChatBubble.lnk'),
        path.join(app.getPath('appData'), 'Microsoft/Windows/Start Menu/Programs/ChatBubble.lnk')] });
  } });
const generate: typeof streamChat = options => options.settings.provider && options.settings.provider !== 'api'
  ? streamCli({ ...options, workDir: options.codex?.session?.cwd ?? path.join(app.getPath('userData'), 'cli-workspace') })
  : streamChat({ ...options, attachmentDirectory: path.join(store.directory, 'attachments') });
const publicState = () => ({ session: state.session, settings: { ...state.settings, ...petOptions(state.settings) }, busy: chat.busy, hasKey: !!vault.forEndpoint(state.settings.baseUrl),
  capture: { ...captureCapability(state.settings), status: screenCapture?.status ?? 'empty' },
  storage: { directory: store.directory, archiveDirectory: store.archiveDirectory, appDirectory: app.getPath('userData') },
  warning: [recoveryWarning, vault.warning, chat.warning].filter(Boolean).join(' ') });
function broadcast(): void {
  for (const target of [window, settingsWindow]) if (target && !target.isDestroyed()) target.webContents.send('chat:state', publicState());
}
function desktopShortcutRoots(): string[] {
  return [app.getPath('desktop'), path.join(app.getPath('appData'), 'Microsoft/Windows/Start Menu/Programs'),
    ...(process.env.PUBLIC ? [path.join(process.env.PUBLIC, 'Desktop')] : []),
    ...(process.env.ProgramData ? [path.join(process.env.ProgramData, 'Microsoft/Windows/Start Menu/Programs')] : [])];
}
function scheduleSave(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { chat.saveSoon(); }, 300);
}
function secureWindow(target: BrowserWindow): void {
  target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  target.webContents.on('will-navigate', event => event.preventDefault());
}
async function openSettings(): Promise<void> {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    const target = settingsWindow;
    if (target.isMaximized()) target.unmaximize();
    if (target.isMinimized()) target.restore();
    settingsManuallySized = false;
    target.setContentSize(420, 430);
    await target.webContents.executeJavaScript("window.dispatchEvent(new Event('settings-fit'))");
    if (!target.isDestroyed()) { target.show(); target.focus(); }
    return;
  }
  settingsManuallySized = false;
  settingsWindow = new BrowserWindow({ icon: appIcon, width: 420, height: 430, useContentSize: true,
    minWidth: 360, minHeight: 240, resizable: true, maximizable: true, show: false, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  secureWindow(settingsWindow);
  const target = settingsWindow;
  target.on('will-resize', () => { settingsManuallySized = true; });
  target.on('maximize', () => { settingsManuallySized = true; });
  let allowClose = false, handlingClose = false;
  target.on('close', event => {
    if (quitting || allowClose) return;
    event.preventDefault(); if (handlingClose) return; handlingClose = true;
    void flushSettings().then(ok => { if (ok && !target.isDestroyed()) { allowClose = true; target.close(); } }).finally(() => { handlingClose = false; });
  });
  settingsWindow.on('closed', () => { settingsWindow = null; });
  await settingsWindow.loadFile(settingsPage);
  settingsWindow.show();
}
function flushSettings(): Promise<boolean> {
  if (settingsFlush) return settingsFlush;
  const target = settingsWindow;
  if (!target || target.isDestroyed()) return Promise.resolve(true);
  settingsFlush = (async () => {
    flushingSettings = true;
    try {
      if (await target.webContents.executeJavaScript('window.flushSettings ? window.flushSettings() : true')) return true;
      const answer = await dialog.showMessageBox(target, { type: 'warning', message: '有更改尚未保存', detail: '请继续编辑，或放弃尚未保存的更改。原来的有效配置会保留。', buttons: ['继续编辑', '放弃更改'], defaultId: 0, cancelId: 0 });
      return answer.response === 1;
    } catch { return false; }
    finally { flushingSettings = false; settingsFlush = undefined; }
  })();
  return settingsFlush;
}
async function startNew(): Promise<void> {
  if (configuring || checking || closing) return;
  configuring = true;
  await chat.stop();
  const previous = state.session;
  try {
    await chat.persist();
    await store.archive(state);
    screenCapture.clear(); state.session = newSession(conversationSource(state.settings)); await chat.persist(); broadcast();
  } catch { state.session = previous; broadcast(); await dialog.showMessageBox(window, { type: 'error', message: '对话保存失败，请检查磁盘权限。' }); }
  finally { configuring = false; }
}

function setMode(next: WindowMode): void {
  if (modeApplied && next === mode) return;
  const previous = mode;
  mode = next;
  modeApplied = true;
  if (previous !== 'expanded' && next === 'expanded' && state.settings.provider === 'codex-cli' && state.session.codex && !historyRefresh && !smoke && !restartMode) {
    historyRefresh = chat.synchronize(() => readCodexUpdates({ executable: state.settings.cliPath!, binding: { ...state.session.codex! } }))
      .catch(() => { /* Sending reports actionable errors; a passive refresh never interrupts typing. */ }).finally(() => { historyRefresh = undefined; });
  }
  // Dragging the collapsed pet must not activate our desktop-sized window.
  window.setFocusable(next === 'expanded');
  window.webContents.send('window:mode', next);
  if (next === 'hidden') { window.hide(); return; }
  if (next === 'expanded') { window.show(); window.focus(); }
  else if (!window.isVisible()) window.showInactive();
}
async function requestScreenCapture(): Promise<{ ok: boolean; error: string }> {
  const capability = captureCapability(state.settings);
  if (!capability.available) return { ok: false, error: capability.reason };
  if (mode !== 'expanded' || smoke || restartMode) return { ok: false, error: '请先打开聊天框。' };
  if (configuring || closing || chat.busy || screenCapture.status === 'capturing') return { ok: false, error: '请等待当前操作完成。' };
  try {
    const result = await screenCapture.request();
    if (result.image && screenCapture.status === 'ready') {
      try {
        const image = nativeImage.createFromPath(result.image.file);
        if (image.isEmpty()) throw new Error('Invalid capture image');
        await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image.toPNG())], { type: 'image/png' }) })]);
      } catch { return { ok: true, error: '截图已保存并附上，但未能复制到剪贴板，请重新截图。' }; }
    }
    return { ok: !!result.image, error: result.error ? '未能读取画面' : '' };
  } catch { screenCapture.clear(); return { ok: false, error: '未能读取画面' }; }
}
function desktopScene(): DesktopScene {
  const first = workAreas[0]!;
  const legacy = state.bounds;
  const fallback = { x: legacy ? legacy.x + legacy.width - 30 : first.x + first.width - 110,
    y: legacy ? legacy.y + legacy.height - 35 : first.y + first.height * .65, side: null };
  const options = petOptions(state.settings), position = { ...(state.petPosition || fallback) };
  if (!options.petEnabled) position.side = null;
  return { bounds: expandedBounds, areas: workAreas, mode, options,
    position: placePet(position, workAreas, options.petSize) };
}
function updateMouseRouting(): void {
  const cursor = screen.getCursorScreenPoint(), x = cursor.x - expandedBounds.x, y = cursor.y - expandedBounds.y;
  const ignore = !petDragging && !inputRegions.some(r => x >= r.x && x <= r.x+r.width && y >= r.y && y <= r.y+r.height);
  if (ignore !== ignoringMouse) { ignoringMouse = ignore; window.setIgnoreMouseEvents(ignore, { forward: true }); }
}

function updateNativeShape(): void {
  // A local paint envelope is independent of the exact mouse hit regions.
  // It stays stable during a hop/return and expands only for long drags.
  // Legacy callers without an envelope still get unrestricted capture.
  const regions = petDragging && !nativePaintRegions.length ? [] : (nativePaintRegions.length ? nativePaintRegions : inputRegions).map(r => {
    const x = Math.max(0, Math.floor((r.x - 16) / 32) * 32);
    const y = Math.max(0, Math.floor((r.y - 16) / 32) * 32);
    return { x, y, width: Math.min(expandedBounds.width, Math.ceil((r.x + r.width + 16) / 32) * 32) - x,
      height: Math.min(expandedBounds.height, Math.ceil((r.y + r.height + 16) / 32) * 32) - y };
  });
  if (!petDragging && !regions.length) return;
  const key = JSON.stringify(regions);
  if (key !== nativeShape) { window.setShape(regions); nativeShape = key; }
}

function trayImage(): Electron.NativeImage {
  return nativeImage.createFromPath(appIcon);
}

async function createWindow(): Promise<void> {
  const defaultChat = smoke || restartMode ? app.getPath('userData') : path.join(app.isPackaged ? path.dirname(process.execPath) : app.getAppPath(), 'chat');
  store = await ChatStorage.open(app.getPath('userData'), defaultChat);
  const loaded = await store.load(); state = loaded.value;
  state.settings = { ...state.settings, ...petOptions(state.settings) };
  // The renderer's first scene must agree with the mode that will be shown.
  // Loading the page before deciding this can return a stale expanded scene.
  mode = smoke ? 'expanded' : 'collapsed';
  if (loaded.recovered) recoveryWarning = '已从备份恢复数据，损坏的原文件已保留。';
  if (store.locationRecovered) recoveryWarning += ' 存储位置配置已从备份恢复，请在设置中核对聊天目录。';
  const sourceWarning = await prepareConversation(state, snapshot => store.archive(snapshot), () => store.save(state));
  if (sourceWarning) recoveryWarning += ' ' + sourceWarning;
  for (const message of state.session.messages) if (message.status === 'generating') { message.status = 'interrupted'; message.error = '上次运行意外结束，回答未完成。'; }
  vault = new Vault(path.join(app.getPath('userData'), 'credentials.json')); await vault.load();
  await migrateScreenshots(store.directory);
  if (captureCapability(state.settings).available && !smoke && !restartMode) nativeCapture = new WindowCapture();
  screenCapture = new ScreenCapture(() => store.directory, async () => {
    if (!nativeCapture || nativeCapture.isClosed) nativeCapture = new WindowCapture();
    return state.settings.captureScope === 'screen' ? nativeCapture.captureMonitor() : nativeCapture.capture();
  }, () => {
    if (!nativeCapture || nativeCapture.isClosed) nativeCapture = new WindowCapture();
    return nativeCapture.prepareCapture(state.settings.captureScope ?? 'window');
  }, broadcast);
  chat = new ChatController(state, store, () => vault.forEndpoint(state.settings.baseUrl), broadcast, fetcher, generate, () => screenCapture.take());
  await chat.persist();
  workAreas = screen.getAllDisplays().map(display => ({ ...display.workArea, id: display.id }));
  expandedBounds = desktopBounds(workAreas);
  // Chromium's native occlusion tracker uses the whole HWND bounds for simple
  // rectangular regions, even when setShape clips us to a tiny paint envelope.
  // A Windows tool window is excluded from that opaque-window calculation.
  window = new BrowserWindow({
    icon: appIcon, type: 'toolbar',
    ...expandedBounds, show: false, focusable: false, frame: false, transparent: true,
    backgroundColor: '#00000000', resizable: false, maximizable: false,
    fullscreenable: false, hasShadow: false, alwaysOnTop: true, skipTaskbar: true, thickFrame: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true }
  });
  secureWindow(window);
  // Mouse routing and native clipping have different jobs: clipping also removes
  // the desktop-sized invisible area from the native window region.
  window.setIgnoreMouseEvents(true, { forward: true });
  window.on('blur', () => { petDragging = false; updateNativeShape(); updateMouseRouting(); if (mode === 'expanded') setMode('collapsed'); });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.on('close', event => { if (!quitting) { event.preventDefault(); setMode('hidden'); } });
  const validate = (event: Electron.IpcMainInvokeEvent, settingsOnly = false): void => {
    const source = [window, settingsWindow].find(w => w && !w.isDestroyed() && w.webContents === event.sender);
    if (!source || (settingsOnly && source !== settingsWindow) || event.senderFrame !== source.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(source === window ? page : settingsPage).href) throw new Error('Invalid sender');
  };
  ipcMain.handle('app:version', event => { validate(event, true); return app.getVersion(); });
  ipcMain.handle('app:update:state', event => { validate(event, true); return updates.state; });
  ipcMain.handle('app:update:check', event => { validate(event, true); return updates.check(); });
  ipcMain.handle('app:update:download', event => {
    validate(event, true);
    if (!app.isPackaged || process.platform !== 'win32') return { ...updates.state, message: '请使用 Windows 便携发布版执行更新。' };
    if (closing) return updates.state;
    return updates.download();
  });
  ipcMain.handle('app:update:restart', event => {
    validate(event, true);
    if (!app.isPackaged || !updates.launchConfig) return { ...updates.state, message: '请先在便携发布版下载并准备更新。' };
    if (chat.busy || configuring || checking || closing) return { ...updates.state, message: '请等待当前回复或保存完成后，再重启更新。' };
    pendingUpdateLaunch = updates.launchConfig; app.quit(); return updates.state;
  });
  ipcMain.handle('window:mode', (event, next: unknown) => {
    validate(event);
    if (next !== 'expanded' && next !== 'collapsed' && next !== 'hidden') throw new Error('Invalid mode');
    setMode(next);
  });
  const validatePet = (event: Electron.IpcMainInvokeEvent): void => { validate(event); if (event.sender !== window.webContents) throw new Error('Invalid pet sender'); };
  ipcMain.handle('screen:capture', event => { validatePet(event); return requestScreenCapture(); });
  ipcMain.handle('screen:clear', event => {
    validatePet(event);
    if (configuring || closing || chat.busy) return { ok: false, error: '请等待当前操作完成。' };
    screenCapture.clear(); return { ok: true, error: '' };
  });
  ipcMain.handle('desktop:scene', event => { validatePet(event); return desktopScene(); });
  ipcMain.handle('desktop:shape', (event, raw: unknown, dragging: unknown, paint: unknown = []) => {
    validatePet(event); if (typeof dragging !== 'boolean') throw new Error('Invalid pointer state');
    if (!Array.isArray(paint) || paint.length > 1) throw new Error('Invalid paint region');
    const nextInput = shapeRegions(raw, expandedBounds), nextPaint = paint.length ? shapeRegions(paint, expandedBounds) : [];
    inputRegions = nextInput; nativePaintRegions = nextPaint; petDragging = dragging; updateNativeShape(); updateMouseRouting();
  });
  ipcMain.handle('desktop:position', (event, raw: unknown) => {
    validatePet(event); if (!isPetPosition(raw)) throw new Error('Invalid pet position');
    const options = petOptions(state.settings);
    state.petPosition = placePet({ ...raw, side: options.petEnabled ? raw.side : null }, workAreas, options.petSize); scheduleSave();
  });
  ipcMain.handle('chat:submit', (event, text: unknown, sessionId: unknown) => {
    validate(event);
    if (typeof text !== 'string' || !canSubmit(text, false)) return { ok: false, error: '请输入消息。' };
    if (configuring || closing) return { ok: false, error: '正在保存或退出，请稍后发送。' };
    if (screenCapture.status === 'capturing') return { ok: false, error: '请等待截图完成后发送。' };
    if (sessionId !== undefined && sessionId !== state.session.id) return { ok: false, error: '对话已切换，请在当前对话重新发送。' };
    return chat.send(text);
  });
  ipcMain.handle('chat:state', event => { validate(event); return publicState(); });
  ipcMain.handle('chat:draft', (event, text: unknown, sessionId: unknown) => {
    validate(event);
    if (typeof text !== 'string' || text.length > 200000) throw new Error('草稿过长，未保存。');
    if (sessionId !== undefined && sessionId !== state.session.id) return;
    state.session.draft = text; scheduleSave();
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('chat:state', publicState());
  });
  ipcMain.handle('chat:stop', event => { validate(event); return chat.stop(); });
  ipcMain.handle('chat:retry', event => {
    validate(event);
    if (configuring || closing) return { ok: false, error: '正在保存或退出，请稍后重试。' };
    return chat.send(state.session.messages.at(-2)?.content, true);
  });
  ipcMain.handle('link:open', async (event, url: unknown) => {
    validate(event);
    if (typeof url !== 'string' || url.length > 4096) throw new Error('Invalid URL');
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid URL');
    await shell.openExternal(target.href);
  });
  ipcMain.handle('settings:save', async (event, raw: unknown) => {
    validate(event, true);
    if (configuring || (closing && !flushingSettings) || chat.busy || checking) return { ok: false, error: '请等待当前操作完成。' };
    configuring = true;
    try {
      const previousCaptureScope = state.settings.captureScope ?? 'window';
      const previousCaptureConnection = JSON.stringify([state.session.id, state.settings.provider, state.settings.baseUrl, state.settings.model, state.settings.cliModel]);
      if (raw && typeof raw === 'object' && 'key' in raw) {
        const secret = raw as { key: unknown; keyEndpoint: unknown };
        if (Object.keys(raw).some(k => !['key', 'keyEndpoint'].includes(k)) || typeof secret.key !== 'string' || secret.key.length > 8192 || /[\r\n\0]/.test(secret.key)) throw new Error('密钥格式不正确。');
        if ((state.settings.provider ?? 'api') !== 'api' || secret.keyEndpoint !== state.settings.baseUrl) throw new Error('服务地址已改变，请重新输入密钥。');
        endpoint(state.settings.baseUrl);
        await vault.save(secret.key, state.settings.baseUrl);
      } else await persistSettingsPatch(state, raw, () => chat.persist(), undefined, snapshot => store.archive(snapshot));
      if ((state.settings.captureScope ?? 'window') !== previousCaptureScope || previousCaptureConnection !== JSON.stringify([state.session.id, state.settings.provider, state.settings.baseUrl, state.settings.model, state.settings.cliModel])) screenCapture.clear();
      if (!captureCapability(state.settings).available) {
        screenCapture.clear(); nativeCapture?.close(); nativeCapture = undefined;
      } else if (!smoke && !restartMode && (!nativeCapture || nativeCapture.isClosed)) nativeCapture = new WindowCapture();
      broadcast(); return { ok: true, error: '' };
    } catch (error) { broadcast(); return { ok: false, error: (error as Error).message }; }
    finally { configuring = false; }
  });
  ipcMain.handle('settings:resize', (event, height: unknown, resetWidth: unknown = false) => {
    validate(event, true);
    if (typeof height !== 'number' || !Number.isFinite(height) || height < 100 || height > 2400 || typeof resetWidth !== 'boolean') throw new Error('Invalid settings size');
    const target = settingsWindow!;
    if (resetWidth) {
      if (target.isMaximized()) target.unmaximize();
      settingsManuallySized = false;
    }
    if (settingsManuallySized || target.isMaximized()) return;
    const area = screen.getDisplayMatching(target.getBounds()).workArea;
    const [width, currentHeight] = target.getContentSize();
    const nextWidth = resetWidth ? Math.min(420, area.width) : width!;
    const nextHeight = Math.max(240, Math.min(Math.ceil(height), area.height - 80));
    if (width !== nextWidth || currentHeight !== nextHeight) target.setContentSize(nextWidth, nextHeight);
    target.setBounds(clampBounds(target.getBounds(), area));
  });
  ipcMain.handle('settings:check', async event => {
    validate(event, true);
    if (checking || configuring || closing || chat.busy) return { ok: false, error: '请等待当前操作完成。' };
    const cli = state.settings.provider && state.settings.provider !== 'api';
    if (cli ? !state.settings.cliPath : (!state.settings.baseUrl || !state.settings.model)) return { ok: false, error: '请先填写连接设置。' };
    checking = true;
    try { await generate({ settings: state.settings, key: vault.forEndpoint(state.settings.baseUrl), messages: [{ role: 'user', content: '请只回复 OK。' }], signal: new AbortController().signal, onChunk: () => {}, fetcher }); return { ok: true, error: '' }; }
    catch (error) { return { ok: false, error: (error as Error).message }; }
    finally { checking = false; }
  });
  ipcMain.handle('cli:discover', event => { validate(event, true); return discoverCli(); });
  ipcMain.handle('api:presets', event => { validate(event, true); return apiPresets; });
  ipcMain.handle('api:models', async (event, baseUrl: unknown) => {
    validate(event, true);
    if (typeof baseUrl !== 'string' || baseUrl !== state.settings.baseUrl || (state.settings.provider ?? 'api') !== 'api') throw new Error('服务地址已改变，请重新读取模型。');
    return listApiModels({ baseUrl, key: vault.forEndpoint(baseUrl), fetcher });
  });
  ipcMain.handle('cli:models', event => { validate(event, true); return readModelCatalog(); });
  ipcMain.handle('codex:open', async (event, archiveId: unknown) => {
    validate(event, true);
    if (state.settings.provider !== 'codex-cli') return { ok: false, error: '当前连接不是 Codex CLI，请在 ChatBubble 中查看本地对话。' };
    if (configuring || closing || checking) return { ok: false, error: '正在保存，请稍后打开。' };
    configuring = true;
    try {
      const session = archiveId === undefined ? state.session : await store.readArchive(archiveId, conversationSource(state.settings));
      if (recordedSource(session, state.settings) !== 'codex-cli') return { ok: false, error: '这段对话不属于当前连接，已阻止混用。' };
      const binding = session.codex;
      if (!binding) return { ok: false, error: '这段对话尚未创建 Codex 原生会话，请在 ChatBubble 中查看。' };
      if (archiveId === undefined) { await chat.stop(); await chat.persist(); }
      await shell.openExternal('codex://threads/' + binding.threadId); return { ok: true, error: '' };
    }
    catch { return { ok: false, error: '无法读取对话或打开 Codex 桌面端，请检查归档文件并确认已安装 Codex。' }; }
    finally { configuring = false; }
  });
  ipcMain.handle('client:status', async event => {
    validate(event, true);
    const settings = { ...state.settings }, id = apiDesktopClient(settings);
    if (!id) return { baseUrl: settings.baseUrl, name: '', available: false, notice: localApiHistoryNotice };
    const target = await locateDesktopClient(id, desktopShortcutRoots(), file => shell.readShortcutLink(file));
    return { baseUrl: settings.baseUrl, name: desktopClientName(id), available: !!target,
      notice: target ? localApiHistoryNotice : clientNotFound(id) + ' ' + localApiHistoryNotice };
  });
  ipcMain.handle('client:open', async (event, baseUrl: unknown) => {
    validate(event, true);
    const id = apiDesktopClient(state.settings);
    if (!id || baseUrl !== state.settings.baseUrl) return { ok: false, error: '连接方式或服务地址已改变，请重新打开历史对话。' };
    const target = await locateDesktopClient(id, desktopShortcutRoots(), file => shell.readShortcutLink(file));
    if (!target) return { ok: false, error: clientNotFound(id) };
    if (id !== apiDesktopClient(state.settings) || baseUrl !== state.settings.baseUrl) return { ok: false, error: '连接方式或服务地址已改变，请重新打开历史对话。' };
    try {
      const error = await shell.openPath(target);
      return error ? { ok: false, error: `未能启动 ${desktopClientName(id)}，请检查客户端安装。` }
        : { ok: true, error: '' };
    } catch { return { ok: false, error: `未能启动 ${desktopClientName(id)}，请检查客户端安装。` }; }
  });
  ipcMain.handle('storage:open', async (event, kind: unknown) => {
    validate(event, true);
    if (!['chat', 'archives', 'app'].includes(kind as string)) throw new Error('无效的目录。');
    const directory = kind === 'archives' ? store.archiveDirectory : kind === 'app' ? app.getPath('userData') : store.directory;
    await import('node:fs/promises').then(fs => fs.mkdir(directory, { recursive: true }));
    const error = await shell.openPath(directory);
    return { ok: !error, error: error ? '无法打开目录，请检查文件夹是否可用。' : '' };
  });
  ipcMain.handle('storage:choose', async event => {
    validate(event, true);
    if (configuring || closing || chat.busy || checking) return { ok: false, error: '请等待当前操作完成或先停止生成。' };
    configuring = true;
    try {
      const selected = await dialog.showOpenDialog(settingsWindow!, { title: '选择空文件夹保存聊天记录（原目录保留备份）', properties: ['openDirectory', 'createDirectory'] });
      if (selected.canceled || !selected.filePaths[0]) return { ok: false, cancelled: true, error: '' };
      clearTimeout(saveTimer);
      await screenCapture.close();
      await store.relocate(selected.filePaths[0], state);
      await migrateScreenshots(store.directory);
      broadcast(); return { ok: true, error: '' };
    } catch (error) { return { ok: false, error: (error as Error).message }; }
    finally { configuring = false; }
  });
  ipcMain.handle('archives:list', event => { validate(event, true); return store.list(conversationSource(state.settings)); });
  ipcMain.handle('archives:read', (event, id: unknown) => { validate(event, true); return store.readArchive(id, conversationSource(state.settings)); });
  ipcMain.handle('archives:restore', async (event, id: unknown) => {
    validate(event, true);
    if (configuring || closing || chat.busy || checking) return { ok: false, error: '请先等待当前操作完成或停止生成。' };
    configuring = true;
    const previous = state.session;
    try {
      const session = await store.readArchive(id, conversationSource(state.settings));
      const answer = await dialog.showMessageBox(settingsWindow!, { type: 'question', message: '恢复这段历史对话？',
        detail: '当前对话会先保存为归档。恢复后可以继续聊天，不会自动发送消息，也不会替换连接设置。', buttons: ['取消', '恢复'], defaultId: 0, cancelId: 0 });
      if (answer.response !== 1) return { ok: false, cancelled: true, error: '' };
      await chat.persist(); await store.archive(state);
      for (const message of session.messages) if (message.status === 'generating') { message.status = 'interrupted'; message.error = '历史回答未完成，可主动重试。'; }
      screenCapture.clear(); state.session = { ...session, id: newSession().id };
      await chat.persist(); broadcast();
      return { ok: true, error: '' };
    } catch { state.session = previous; broadcast(); return { ok: false, error: '恢复失败，当前对话及归档已保留，请检查磁盘权限或文件是否损坏。' }; }
    finally { configuring = false; }
  });
  ipcMain.handle('cli:pick', async event => {
    validate(event, true);
    const result = await dialog.showOpenDialog(settingsWindow!, { title: '选择 Codex CLI 可执行文件', properties: ['openFile'], filters: [{ name: 'CLI executable', extensions: ['exe'] }] });
    return result.canceled ? '' : result.filePaths[0] ?? '';
  });
  tray = new Tray(trayImage());
  tray.setToolTip('Chat Bubble');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '开始新对话', click: () => { void startNew(); } },
    { label: '设置', click: () => { void openSettings(); } },
    { label: '退出', click: () => app.quit() }
  ]));
  tray.on('click', () => setMode(mode === 'hidden' ? 'collapsed' : 'hidden'));
  const recover = (): void => {
    workAreas = screen.getAllDisplays().map(display => ({ ...display.workArea, id: display.id }));
    expandedBounds = desktopBounds(workAreas); window.setBounds(expandedBounds); inputRegions = []; nativePaintRegions = []; petDragging = false; nativeShape = ''; updateMouseRouting();
    const scene = desktopScene(); state.petPosition = scene.position; scheduleSave();
    window.webContents.send('desktop:scene', scene);
  };
  screen.on('display-added', recover);
  screen.on('display-removed', recover);
  screen.on('display-metrics-changed', recover);
  await window.loadFile(page);
  let lastPointer = '';
  pointerTimer = setInterval(() => {
    if (!window || window.isDestroyed() || !window.isVisible()) return;
    const cursor = screen.getCursorScreenPoint(), key = `${cursor.x},${cursor.y}`;
    updateMouseRouting();
    if (key !== lastPointer) { lastPointer = key; window.webContents.send('desktop:pointer', { x: cursor.x - expandedBounds.x, y: cursor.y - expandedBounds.y }); }
  }, 16);
  setMode(mode);
  if (smoke) await runSmoke();
  if (restartMode) {
    const { restartSmoke } = await import('./smoke-restart');
    await restartSmoke({ phase: restartMode, state, chat, vault, window, storage: store, setMode, dataDir: app.getPath('userData') });
  }
}

async function runSmoke(): Promise<void> {
  const checks: Record<string, boolean> = {};
  const check = (name: string, ok: boolean): void => { checks[name] = ok; if (!ok) throw new Error(name); };
  try {
    const ready = Date.now() + 6000;
    while (!await window.webContents.executeJavaScript('!!window.pet')) { if (Date.now() > ready) throw new Error('Pet initialization timeout'); await new Promise(resolve => setTimeout(resolve, 20)); }
    check('window-visible', window.isVisible());
    check('tray-created', !tray.isDestroyed());
    check('bridge-and-no-node', await window.webContents.executeJavaScript("typeof window.desktop.submit === 'function' && typeof require === 'undefined'"));
    check('ime-enter-not-submitted', await window.webContents.executeJavaScript(`
      (() => {
        const input = document.querySelector('#input');
        input.value = '选词中';
        input.dispatchEvent(new CompositionEvent('compositionstart'));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
        input.dispatchEvent(new CompositionEvent('compositionend'));
        return document.querySelector('#status').hidden;
      })()
    `));
    await window.webContents.executeJavaScript("document.querySelector('#input').value = '中文草稿 smoke'; window.desktop.setMode('collapsed')");
    await new Promise(resolve => setTimeout(resolve, 800));
    check('collapsed-pet-not-placeholder', await window.webContents.executeJavaScript("document.querySelector('#composer').hidden && !document.querySelector('#cb-pet').hidden && !document.querySelector('#launcher') && window.pet.inspect().morph<.02"));
    await window.webContents.executeJavaScript("window.desktop.setMode('hidden')");
    check('hidden-window', !window.isVisible() && !tray.isDestroyed());
    setMode('expanded');
    check('draft-preserved', await window.webContents.executeJavaScript("document.querySelector('#input').value === '中文草稿 smoke'"));
    check('unconfigured-no-fake-reply', await window.webContents.executeJavaScript("window.desktop.submit('测试').then(result => result.ok === false && result.error.includes('尚未接入'))"));
    check('invalid-ipc-rejected', await window.webContents.executeJavaScript("window.desktop.setMode('invalid').then(() => false, () => true)"));
    const artifactDir = process.env.CHATBUBBLE_SMOKE_ARTIFACTS || path.join(app.getAppPath(), 'docs/verification');
    if (!process.argv.includes('--pet-only')) await smokeChat({ window, settingsWindow: () => settingsWindow, openSettings, state, chat, storage: store, dataDir: app.getPath('userData'), artifactDir, setMode, broadcast, check });
    if (!process.argv.includes('--chat-only')) {
      const { smokePet } = await import('./smoke-pet');
      await smokePet({ window, state, chat, openSettings, settingsWindow: () => settingsWindow, artifactDir, setMode, check });
    }
    await writeFile(path.join(artifactDir, 'desktop-smoke.json'), JSON.stringify({ date: new Date().toISOString(), checks, limitations: ['Local HTTP fixture, no paid model requests', process.argv.includes('--real-pet-input') ? 'Physical mouse fixture used' : 'Chromium mouse input with a matching cursor fixture; physical input available with --real-pet-input', 'Native Windows click-through flag checked at current scale; multi-monitor, other scales and real IME remain manual', 'Rest inactivity clock advanced in renderer; full process restart checked separately'] }, null, 2));
    app.exit(0);
  } catch (error) { console.error('Smoke failed:', error); app.exit(1); }
}

if (!app.requestSingleInstanceLock()) {
  if (smoke) { console.error('Exit the running Chat Bubble instance before smoke testing.'); app.exit(1); }
  else app.quit();
}
else {
  app.on('second-instance', () => { if (window && !window.isDestroyed()) setMode('collapsed'); });
  app.on('before-quit', event => {
    if (quitting || !chat) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    void (async () => {
      updates.cancel();
      clearTimeout(saveTimer);
      await chat.stop();
      if (!await flushSettings()) {
        if (pendingUpdateLaunch) { pendingUpdateLaunch = undefined; updates.remainReady('设置尚未保存，已取消重启。保存完成后可再次重启更新。'); }
        closing = false; return;
      }
      try { await chat.persist(); await store.flush(); }
      catch {
        if (pendingUpdateLaunch) { pendingUpdateLaunch = undefined; updates.remainReady('聊天保存失败，已取消重启。请检查磁盘后再试。'); closing = false; return; }
        const answer = await dialog.showMessageBox({ type: 'warning', message: '内容尚未保存，仍然退出吗？', buttons: ['保留窗口', '仍然退出'], defaultId: 0, cancelId: 0 });
        if (answer.response !== 1) { closing = false; return; }
      }
      await screenCapture.close(); nativeCapture?.close();
      if (pendingUpdateLaunch) {
        try { await launchUpdate(pendingUpdateLaunch, updateHelper); }
        catch { pendingUpdateLaunch = undefined; updates.remainReady('未能启动更新助手，已保留当前窗口，请稍后重试。'); closing = false; return; }
      }
      quitting = true; clearInterval(pointerTimer); tray?.destroy(); app.quit();
    })();
  });
  app.on('window-all-closed', () => { /* Tray owns application lifetime. */ });
  void app.whenReady().then(createWindow).catch(() => { dialog.showErrorBox('Chat Bubble 启动失败', '本地数据或窗口无法初始化。原有数据已保留，请检查用户数据目录的权限和备份。'); app.exit(1); });
}
