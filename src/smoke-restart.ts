import { app, BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { writeFile, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import type { ChatStorage } from './chat-storage';
import path from 'node:path';
import type { SavedState } from './model';
import type { ChatController } from './chat';
import type { Vault } from './vault';

export async function restartSmoke(options: {
  phase: string; state: SavedState; chat: ChatController; vault: Vault; window: BrowserWindow;
  setMode: (mode: 'expanded') => void; dataDir: string; storage: ChatStorage;
}): Promise<void> {
  const { state, chat, vault, window } = options;
  if (options.phase === '--restart-seed') {
    state.settings.baseUrl = 'http://127.0.0.1:9/v1'; state.settings.model = 'restart-fixture';
    state.settings.cliModel = 'test-explicit-model'; state.settings.reasoningEffort = 'high'; state.settings.contextBudget = 48000;
    state.settings.petEyeSize = 114; state.settings.petColor = '#3891ff';
    const scene = await window.webContents.executeJavaScript('window.desktop.getDesktopScene()');
    state.petPosition = { ...scene.position, side: 'right' };
    state.session.draft = '跨进程恢复草稿';
    state.session.messages = [
      { id: 'restart-user', role: 'user', content: '未完成的请求', status: 'complete', requestId: 'restart', time: new Date().toISOString() },
      { id: 'restart-assistant', role: 'assistant', content: '已收到部分', status: 'generating', requestId: 'restart', time: new Date().toISOString() }
    ];
    state.session.codex = { threadId: '22222222-2222-4222-8222-222222222222', home: options.dataDir, cwd: options.dataDir, lastTurnId: '33333333-3333-4333-8333-333333333333', lastUserMessageId: '44444444-4444-4444-8444-444444444444' };
    state.session.messages[1]!.codexTurnId = state.session.codex.lastTurnId;
    await vault.save('restart-test-key-not-real', state.settings.baseUrl);
    await chat.persist(); await options.storage.archive(state);
    await options.storage.relocate(await mkdtemp(path.join(os.tmpdir(), 'chatbubble-restart-moved-')), state);
    app.exit(0); return;
  }
  if (options.phase === '--restart-secondary') { app.exit(2); return; }
  const checks: Record<string, boolean> = {};
  const check = (name: string, condition: boolean): void => { checks[name] = condition; if (!condition) throw new Error(name); };
  check('draft-restored-after-process-restart', state.session.draft === '跨进程恢复草稿');
  check('interrupted-not-resent', state.session.messages.at(-1)?.status === 'interrupted' && state.session.messages.at(-1)?.content === '已收到部分' && !chat.busy);
  check('credentials-restored-after-process-restart', vault.forEndpoint(state.settings.baseUrl) === 'restart-test-key-not-real');
  check('custom-chat-location-after-process-restart', options.storage.directory !== options.dataDir && (await options.storage.list()).items.length === 1);
  check('model-effort-budget-after-process-restart', state.settings.cliModel === 'test-explicit-model' && state.settings.reasoningEffort === 'high' && state.settings.contextBudget === 48000);
  check('pet-settings-and-side-after-process-restart', state.settings.petEyeSize === 114 && state.settings.petColor === '#3891ff' && state.petPosition?.side === 'right');
  check('native-codex-identity-after-process-restart', state.session.codex?.threadId === '22222222-2222-4222-8222-222222222222' && state.session.codex.lastUserMessageId === '44444444-4444-4444-8444-444444444444' && state.session.messages[1]?.codexTurnId === state.session.codex.lastTurnId);
  options.setMode('expanded');
  const deadline = Date.now() + 5000;
  while (!await window.webContents.executeJavaScript("document.querySelector('#input').value === '跨进程恢复草稿'")) {
    if (Date.now() > deadline) throw new Error('Renderer restore timeout');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  check('renderer-restored-after-process-restart', true);
  const secondInstance = new Promise<void>(resolve => app.once('second-instance', () => resolve()));
  const child = spawn(process.execPath, [...(app.isPackaged ? [] : [app.getAppPath()]), '--restart-secondary'], { env: process.env, windowsHide: true, stdio: 'ignore' });
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([Promise.all([secondInstance, new Promise<void>((resolve, reject) => {
      child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Secondary exit ${code}`)));
    })]), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Single-instance timeout')), 10000); })]);
    check('second-instance-reuses-existing-window', true);
  } finally { clearTimeout(timer!); if (child.exitCode === null) child.kill(); }
  await writeFile(path.join(process.env.CHATBUBBLE_SMOKE_ARTIFACTS || path.join(app.getAppPath(), 'docs/verification'), 'restart-smoke.json'), JSON.stringify({ date: new Date().toISOString(), checks }, null, 2));
  app.exit(0);
}
