import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('desktop', {
  setMode: (mode: string) => ipcRenderer.invoke('window:mode', mode),
  getDesktopScene: () => ipcRenderer.invoke('desktop:scene'),
  setRegions: (regions: unknown, dragging = false, paintRegions: unknown = []) => ipcRenderer.invoke('desktop:shape', regions, dragging, paintRegions),
  savePetPosition: (position: unknown) => ipcRenderer.invoke('desktop:position', position),
  onDesktopScene: (callback: (scene: unknown) => void) => { ipcRenderer.on('desktop:scene', (_event, scene: unknown) => callback(scene)); },
  onPointer: (callback: (point: unknown) => void) => { ipcRenderer.on('desktop:pointer', (_event, point: unknown) => callback(point)); },
  submit: (text: string, sessionId?: string) => ipcRenderer.invoke('chat:submit', text, sessionId),
  captureWindow: () => ipcRenderer.invoke('screen:capture'),
  clearCapture: () => ipcRenderer.invoke('screen:clear'),
  retry: () => ipcRenderer.invoke('chat:retry'),
  stop: () => ipcRenderer.invoke('chat:stop'),
  getState: () => ipcRenderer.invoke('chat:state'),
  saveDraft: (text: string, sessionId?: string) => ipcRenderer.invoke('chat:draft', text, sessionId),
  saveSettings: (settings: unknown) => ipcRenderer.invoke('settings:save', settings),
  resizeSettings: (height: number, resetWidth = false) => ipcRenderer.invoke('settings:resize', height, resetWidth),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  getUpdateState: () => ipcRenderer.invoke('app:update:state'),
  checkUpdates: () => ipcRenderer.invoke('app:update:check'),
  downloadUpdate: () => ipcRenderer.invoke('app:update:download'),
  restartForUpdate: () => ipcRenderer.invoke('app:update:restart'),
  onUpdate: (callback: (state: unknown) => void) => { ipcRenderer.on('app:update:state', (_event, state: unknown) => callback(state)); },
  checkConnection: () => ipcRenderer.invoke('settings:check'),
  discoverCli: () => ipcRenderer.invoke('cli:discover'),
  pickCli: () => ipcRenderer.invoke('cli:pick'),
  getModelCatalog: () => ipcRenderer.invoke('cli:models'),
  getApiPresets: () => ipcRenderer.invoke('api:presets'),
  getApiModels: (baseUrl: string) => ipcRenderer.invoke('api:models', baseUrl),
  openCodex: (archiveId?: string) => ipcRenderer.invoke('codex:open', archiveId),
  getDesktopClientStatus: () => ipcRenderer.invoke('client:status'),
  openDesktopClient: (baseUrl: string) => ipcRenderer.invoke('client:open', baseUrl),
  openStorage: (kind: string) => ipcRenderer.invoke('storage:open', kind),
  chooseStorage: () => ipcRenderer.invoke('storage:choose'),
  listArchives: () => ipcRenderer.invoke('archives:list'),
  readArchive: (id: string) => ipcRenderer.invoke('archives:read', id),
  restoreArchive: (id: string) => ipcRenderer.invoke('archives:restore', id),
  openLink: (url: string) => ipcRenderer.invoke('link:open', url),
  onState: (callback: (state: unknown) => void) => {
    ipcRenderer.on('chat:state', (_event, state: unknown) => callback(state));
  },
  onMode: (callback: (mode: string) => void) => {
    ipcRenderer.on('window:mode', (_event, mode: string) => callback(mode));
  }
});
