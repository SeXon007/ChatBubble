param([string]$Handles, [long]$Cover = 0, [string]$Allowed = '')
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CaptureExclusionProbe {
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left,top,right,bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct Point { public int x,y; }
  [StructLayout(LayoutKind.Sequential)] public struct Monitor { public int size; public Rect bounds,work; public uint flags; }
  [DllImport("user32.dll")] public static extern bool GetWindowDisplayAffinity(IntPtr h, out uint affinity);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect rect);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr h, ref Monitor info);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
}
'@
[void][CaptureExclusionProbe]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))
$windows = @()
foreach ($handle in ($Handles -split ',')) {
  if (!$handle) { continue }
  $h = [IntPtr]::new([long]$handle)
  [uint32]$affinity = 0
  $read = [CaptureExclusionProbe]::GetWindowDisplayAffinity($h, [ref]$affinity)
  $rect = New-Object CaptureExclusionProbe+Rect
  [void][CaptureExclusionProbe]::GetWindowRect($h, [ref]$rect)
  $windows += @{handle=$handle;affinityRead=$read;affinity=$affinity;visible=[CaptureExclusionProbe]::IsWindowVisible($h);iconic=[CaptureExclusionProbe]::IsIconic($h);rect=$rect}
}
$result = @{windows=$windows;foreground=[CaptureExclusionProbe]::GetForegroundWindow().ToInt64().ToString()}
if ($Cover) {
  $info = New-Object CaptureExclusionProbe+Monitor
  $info.size = [Runtime.InteropServices.Marshal]::SizeOf($info)
  $monitor = [CaptureExclusionProbe]::MonitorFromWindow([IntPtr]::new($Cover), 0)
  if (![CaptureExclusionProbe]::GetMonitorInfo($monitor,[ref]$info)) { throw 'Monitor unavailable' }
  $owned = 0
  foreach ($row in 0..10) { foreach ($column in 0..10) {
    $point = New-Object CaptureExclusionProbe+Point
    $point.x = $info.bounds.left + 2 + [int](($info.bounds.right-$info.bounds.left-4)*$column/10)
    $point.y = $info.bounds.top + 2 + [int](($info.bounds.bottom-$info.bounds.top-4)*$row/10)
    $hit = [CaptureExclusionProbe]::GetAncestor([CaptureExclusionProbe]::WindowFromPoint($point),2).ToInt64().ToString()
    if (($Allowed -split ',') -contains $hit) { $owned++ }
  } }
  $result.monitor = $monitor.ToInt64().ToString()
  $result.ownedPoints = $owned
  $result.allGridCovered = $owned -eq 121
}
$result | ConvertTo-Json -Depth 5 -Compress
