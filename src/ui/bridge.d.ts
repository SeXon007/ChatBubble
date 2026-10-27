type PublicState = {
  session: import('../model').Session;
  settings: import('../model').Settings;
  busy: boolean; warning: string; hasKey: boolean;
  capture: { available: boolean; reason?: string; status: import('../screen-capture').CaptureStatus };
  storage: { directory: string; archiveDirectory: string; appDirectory: string };
};
interface DesktopBridge {
  setMode(mode: 'expanded' | 'collapsed' | 'hidden'): Promise<void>;
  getDesktopScene(): Promise<import('../pet-state').DesktopScene>;
  setRegions(regions: import('../window-state').Rect[], dragging?: boolean, paintRegions?: import('../window-state').Rect[]): Promise<void>;
  savePetPosition(position: import('../pet-state').PetPosition): Promise<void>;
  onDesktopScene(callback: (scene: import('../pet-state').DesktopScene) => void): void;
  onPointer(callback: (point: { x: number; y: number }) => void): void;
  submit(text: string, sessionId?: string): Promise<{ ok: boolean; error: string }>;
  captureWindow(): Promise<{ ok: boolean; error: string }>;
  clearCapture(): Promise<{ ok: boolean; error: string }>;
  retry(): Promise<{ ok: boolean; error: string }>;
  stop(): Promise<void>;
  getState(): Promise<PublicState>;
  saveDraft(text: string, sessionId?: string): Promise<void>;
  saveSettings(settings: unknown): Promise<{ ok: boolean; error: string }>;
  resizeSettings(height: number, resetWidth?: boolean): Promise<void>;
  getAppVersion(): Promise<string>;
  getUpdateState(): Promise<import('../updates').UpdateState>;
  checkUpdates(): Promise<import('../updates').UpdateState>;
  downloadUpdate(): Promise<import('../updates').UpdateState>;
  restartForUpdate(): Promise<import('../updates').UpdateState>;
  onUpdate(callback: (state: import('../updates').UpdateState) => void): void;
  checkConnection(): Promise<{ ok: boolean; error: string }>;
  discoverCli(): Promise<import('../cli').CliCandidate[]>;
  pickCli(): Promise<string>;
  getModelCatalog(): Promise<import('../cli-models').ModelCatalog>;
  getApiPresets(): Promise<import('../api-models').ApiPreset[]>;
  getApiModels(baseUrl: string): Promise<import('../api-models').ApiModelCatalog>;
  openCodex(archiveId?: string): Promise<{ ok: boolean; error: string }>;
  getDesktopClientStatus(): Promise<import('../desktop-client').DesktopClientStatus>;
  openDesktopClient(baseUrl: string): Promise<{ ok: boolean; error: string }>;
  openStorage(kind: 'chat' | 'archives' | 'app'): Promise<{ ok: boolean; error: string }>;
  chooseStorage(): Promise<{ ok: boolean; cancelled?: boolean; error: string }>;
  listArchives(): Promise<{ items: import('../chat-storage').ArchiveInfo[]; unreadable: number; unclassified?: number }>;
  readArchive(id: string): Promise<import('../model').Session>;
  restoreArchive(id: string): Promise<{ ok: boolean; cancelled?: boolean; error: string }>;
  openLink(url: string): Promise<void>;
  onMode(callback: (mode: string) => void): void;
  onState(callback: (state: PublicState) => void): void;
}
interface Window { desktop: DesktopBridge; flushSettings?: () => Promise<boolean>; pet?: {
  configure(settings: import('../model').Settings): void;
  setMode(mode: string): void;
  resizeComposer(height: number): void;
  inspect(): { x: number; y: number; side: string | null; mode: string; morph: number; expression: string };
} }
