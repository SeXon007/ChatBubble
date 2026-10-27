param([int]$OwnerPid, [switch]$CompileOnly)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$targetSource = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class ChatBubbleTarget {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int Size; public RECT Monitor, Work; public uint Flags; }
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(POINT point, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder text, int size);
  [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr h, out uint affinity);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  static int owner; static Thread worker; static Process ownerProcess; static string published;
  static string publishedMonitor;
  public static string MonitorInfo(long handle) {
    MONITORINFO info=new MONITORINFO(); info.Size=Marshal.SizeOf(typeof(MONITORINFO));
    if(handle==0 || !GetMonitorInfo(new IntPtr(handle),ref info)) return "null";
    RECT r=info.Monitor;
    if(r.Right<=r.Left || r.Bottom<=r.Top) return "null";
    return "{\"handle\":\""+handle+"\",\"width\":"+(r.Right-r.Left)+",\"height\":"+(r.Bottom-r.Top)+"}";
  }
  public static bool ValidateMonitor(long handle) { return MonitorInfo(handle)!="null"; }
  static void SampleMonitor() {
    POINT point;
    string info=GetCursorPos(out point) ? MonitorInfo(MonitorFromPoint(point,0).ToInt64()) : "null";
    if(info==publishedMonitor) return;
    publishedMonitor=info; Console.WriteLine("{\"monitor\":"+info+"}");
  }
  // Zero foreground handles are normal during focus transitions. They must not
  // erase the last external window just before our overlay takes focus.
  public static string Observe(long handle, bool own, bool taskbar, bool desktop, string info) {
    if(handle==0 || own || taskbar) return null;
    string next=desktop ? "null" : info;
    if(next==published) return null;
    published=next; return "{\"target\":"+next+"}";
  }
  static void Sample() {
    SampleMonitor();
    IntPtr h=GetForegroundWindow(); uint p; GetWindowThreadProcessId(h, out p);
    if (h==IntPtr.Zero || p==0 || p==(uint)owner) return;
    StringBuilder name=new StringBuilder(256); GetClassName(h,name,256);
    string c=name.ToString();
    bool taskbar=c=="Shell_TrayWnd" || c=="Shell_SecondaryTrayWnd";
    if(taskbar) return;
    bool desktop=c=="Progman" || c=="WorkerW";
    // Compare the validated observation, not just the HWND: a restored window
    // can become readable without changing its handle.
    string update=Observe(h.ToInt64(),false,false,desktop,desktop ? "null" : Info(h));
    if(update!=null) Console.WriteLine(update);
  }
  public static void Start(int pid) {
    SetProcessDpiAwarenessContext(new IntPtr(-4)); owner=pid; ownerProcess=Process.GetProcessById(pid); Sample();
    worker=new Thread(delegate() {
      while(true) {
        try { if(ownerProcess.HasExited) Environment.Exit(0); Sample(); }
        catch { Environment.Exit(0); }
        Thread.Sleep(40);
      }
    }); worker.IsBackground=true; worker.Start();
  }
  static string Info(IntPtr h) {
    uint p, affinity;
    GetWindowThreadProcessId(h,out p); RECT r;
    if(h==IntPtr.Zero || p==0 || p==(uint)owner || !IsWindowVisible(h) || IsIconic(h) || !GetWindowRect(h,out r)) return "null";
    if(GetWindowDisplayAffinity(h,out affinity) && affinity!=0) return "null";
    return "{\"handle\":\""+h.ToInt64()+"\",\"pid\":"+p+",\"width\":"+(r.Right-r.Left)+",\"height\":"+(r.Bottom-r.Top)+"}";
  }
  public static bool Validate(long handle, uint expectedPid) {
    IntPtr h=new IntPtr(handle);
    if(Info(h)=="null") return false;
    uint actual; GetWindowThreadProcessId(h,out actual);
    return actual==expectedPid;
  }
}
'@
$frameworkRoot = [Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
$metadataRoot = Join-Path $env:SystemRoot 'System32/WinMetadata'
$compiler = New-Object System.CodeDom.Compiler.CompilerParameters
$compiler.GenerateInMemory = $true
$compiler.ReferencedAssemblies.AddRange([string[]]@('System.dll','System.Core.dll',(Join-Path $frameworkRoot 'System.Runtime.dll'),(Join-Path $frameworkRoot 'System.Runtime.WindowsRuntime.dll')))
$compiler.CompilerOptions = (@('Windows.Foundation.winmd','Windows.Graphics.winmd','Windows.Storage.winmd') | ForEach-Object { '/r:"' + (Join-Path $metadataRoot $_) + '"' }) -join ' '
$frameSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'window-frame.cs') -Raw
Add-Type -CompilerParameters $compiler -TypeDefinition ($targetSource + "`n" + $frameSource)
if ($CompileOnly) { [ChatBubbleCapture.WindowFrame]::BackendName(); return }
[ChatBubbleTarget]::Start($OwnerPid)
[Console]::WriteLine('{"ready":true}')
while ($null -ne ($commandLine = [Console]::ReadLine())) {
  if ($commandLine -match '^monitor:(\d+)$') {
    try { [Console]::WriteLine([ChatBubbleCapture.WindowFrame]::CaptureMonitor([long]$Matches[1])) }
    catch { [Console]::WriteLine('{"error":"native-exception"}') }
  }
  if ($commandLine -match '^capture:(\d+):(\d+)$') {
    try { [Console]::WriteLine([ChatBubbleCapture.WindowFrame]::Capture([long]$Matches[1], [uint32]$Matches[2])) }
    catch { [Console]::WriteLine('{"error":"native-exception"}') }
  }
}
