export type CaptureFailureCode = 'no-target' | 'window-unavailable' | 'identity-changed' | 'print-window-failed' | 'blank-image' | 'capture-timeout' | 'startup-timeout' | 'helper-closed' | 'helper-protocol' | 'image-invalid' | 'image-save' | 'capture-unsupported';
const reasons: Record<CaptureFailureCode, string> = {
  'no-target': '尚未识别到目标窗口', 'window-unavailable': '目标窗口不可读取', 'identity-changed': '目标窗口已改变',
  'print-window-failed': '目标软件未提供画面', 'blank-image': '目标软件返回空白画面', 'capture-timeout': '窗口捕获超时',
  'startup-timeout': '读屏助手启动超时', 'helper-closed': '读屏助手已断开', 'helper-protocol': '读屏助手响应异常',
  'image-invalid': '窗口图片无效', 'image-save': '图片暂存失败', 'capture-unsupported': '系统画面捕获暂不可用'
};
export class CaptureError extends Error {
  constructor(readonly code: CaptureFailureCode) { super(reasons[code]); }
}
export function captureFailure(error: unknown): CaptureFailureCode {
  return error instanceof CaptureError ? error.code : 'image-save';
}
export function captureNotice(code: CaptureFailureCode): string { return `本次未能读取目标窗口（${reasons[code]}），已按文字发送。`; }
export function nativeFailure(value: unknown): CaptureFailureCode {
  return typeof value === 'string' && Object.hasOwn(reasons, value) ? value as CaptureFailureCode : 'image-invalid';
}
