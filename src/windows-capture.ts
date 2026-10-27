import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { CaptureError, nativeFailure, type CaptureFailureCode } from './capture-errors';
export interface WindowTarget { handle: string; pid: number; width: number; height: number }
export interface MonitorTarget { handle: string; width: number; height: number }
interface CaptureOptions { executable?: string; args?: string[]; startupTimeoutMs?: number; captureTimeoutMs?: number }

// Window/monitor tracking reads identity only. A short-lived compositor session
// copies one selected frame; no request to redraw the target application.
export class WindowCapture {
  private child?: ChildProcessWithoutNullStreams;
  private ready: Promise<void>;
  private pending?: { resolve: (image: Buffer | null) => void; timer: ReturnType<typeof setTimeout> };
  private closed = false;
  private initialized = false;
  target: WindowTarget | null = null;
  monitor: MonitorTarget | null = null;
  private captureError: CaptureFailureCode = 'image-invalid';
  get isClosed(): boolean { return this.closed; }
  constructor(private options: CaptureOptions = {}) {
    this.ready = new Promise<void>((resolve, reject) => {
      if (process.platform !== 'win32' && !options.executable) { this.closed = true; reject(new CaptureError('helper-closed')); return; }
      const child = this.child = spawn(options.executable ?? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        options.args ?? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'native/window-target.ps1'), '-OwnerPid', String(process.pid)],
        { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { reject(new CaptureError('startup-timeout')); this.close(); }, options.startupTimeoutMs ?? 15000);
      const fail = (): void => { clearTimeout(timer); reject(new CaptureError('helper-closed')); this.captureError = 'helper-closed'; this.finish(null); this.closed = true; };
      child.on('error', fail); child.on('close', fail); child.stdin.on('error', fail);
      child.stderr.on('data', () => {});
      let buffer = ''; child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 23000000) { fail(); this.close(); return; }
        let end: number;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
          try {
            const value = JSON.parse(line);
            if (value && 'target' in value) this.target = value.target;
            else if (value && 'monitor' in value) this.monitor = value.monitor;
            else if (value?.ready) { clearTimeout(timer); this.initialized = true; resolve(); }
            else { this.captureError = nativeFailure(value?.error); this.finish(typeof value?.image === 'string' ? Buffer.from(value.image, 'base64') : null); }
          } catch { fail(); this.close(); }
        }
      });
    });
    void this.ready.catch(() => {});
  }
  private finish(image: Buffer | null): void {
    const request = this.pending; this.pending = undefined;
    if (request) { clearTimeout(request.timer); request.resolve(image); }
  }
  prepareCapture(scope: 'window' | 'screen' = 'window'): () => Promise<Buffer> {
    if (scope === 'screen') {
      const monitor = this.initialized ? (this.monitor ? { ...this.monitor } : null) : undefined;
      return () => this.captureMonitor(monitor);
    }
    // Once ready, freeze the selected external identity at manual request time.
    // While starting, defer selection until the helper's initial observation.
    const target = this.initialized ? (this.target ? { ...this.target } : null) : undefined;
    return () => this.capture(target);
  }
  async capture(target?: WindowTarget | null): Promise<Buffer> {
    await this.ready;
    const selected = target === undefined ? this.target : target;
    if (!selected || !/^\d+$/.test(selected.handle) || !Number.isInteger(selected.pid)) throw new CaptureError('no-target');
    return this.requestCapture(`capture:${selected.handle}:${selected.pid}`);
  }
  async captureMonitor(target?: MonitorTarget | null): Promise<Buffer> {
    await this.ready;
    const selected = target === undefined ? this.monitor : target;
    if (!selected || !/^\d+$/.test(selected.handle) || !Number.isInteger(selected.width) || selected.width <= 0 || !Number.isInteger(selected.height) || selected.height <= 0) throw new CaptureError('no-target');
    return this.requestCapture(`monitor:${selected.handle}`);
  }
  private async requestCapture(command: string): Promise<Buffer> {
    if (this.closed || !this.child) throw new CaptureError('helper-closed');
    if (this.pending) throw new CaptureError('helper-protocol');
    const data = await new Promise<Buffer | null>(resolve => {
      this.pending = { resolve, timer: setTimeout(() => { this.captureError = 'capture-timeout'; this.finish(null); this.close(); }, this.options.captureTimeoutMs ?? 2500) };
      this.child!.stdin.write(command + '\n');
    });
    if (!data || data.length < 80 || data.length > 16000000) throw new CaptureError(this.captureError);
    return data;
  }
  close(): void { this.closed = true; this.finish(null); this.child?.stdin.end(); this.child?.kill(); }
}
