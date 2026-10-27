param([Parameter(Mandatory=$true)][ValidateSet('Prepare','Launch')][string]$Mode,
      [Parameter(Mandatory=$true)][string]$Config)
$ErrorActionPreference = 'Stop'
$configPath = [IO.Path]::GetFullPath($Config)
$job = [IO.File]::ReadAllText($configPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
if ($job.version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$' -or $job.sha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid update metadata' }
$oldExe = [IO.Path]::GetFullPath($job.oldExecutable)
if ([IO.Path]::GetFileName($oldExe) -ne 'ChatBubble.exe') { throw 'Invalid old executable' }
$parent = [IO.Directory]::GetParent([IO.Path]::GetDirectoryName($oldExe)).FullName
if ((Get-Item -LiteralPath $parent).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Update parent is a link' }
$bundleName = 'ChatBubble-' + $job.version + '-win32-x64'
$destination = [IO.Path]::GetFullPath((Join-Path $parent $bundleName))
$parentPrefix = $parent.TrimEnd('\') + '\'
if (![IO.Path]::GetDirectoryName($destination).Equals($parent, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid update destination' }
$newExe = Join-Path $destination 'ChatBubble.exe'
$log = Join-Path ([IO.Path]::GetDirectoryName($configPath)) 'install.log'
function Log([string]$message) { [IO.File]::AppendAllText($log, ([DateTime]::UtcNow.ToString('s') + ' ' + $message + "`r`n")) }
if ($Mode -eq 'Prepare') {
  if (Test-Path -LiteralPath $destination) { throw 'Destination already exists; never overwrite a version' }
  $sha = [Security.Cryptography.SHA256]::Create(); $zipStream = [IO.File]::OpenRead($job.zip)
  try { $actualHash = [BitConverter]::ToString($sha.ComputeHash($zipStream)).Replace('-','').ToLowerInvariant() }
  finally { $zipStream.Dispose(); $sha.Dispose() }
  if ($actualHash -ne $job.sha256) { throw 'Archive checksum mismatch' }
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($job.zip)
  $stage = [IO.Path]::GetFullPath((Join-Path $parent ('.chatbubble-update-' + [Guid]::NewGuid().ToString('N'))))
  if (!$stage.StartsWith($parentPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid staging directory' }
  try {
    if ($archive.Entries.Count -lt 5 -or $archive.Entries.Count -gt 3000) { throw 'Invalid archive entry count' }
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    [long]$total = 0
    foreach ($entry in $archive.Entries) {
      $name = $entry.FullName
      if (!$name.StartsWith($bundleName + '/', [StringComparison]::Ordinal) -or $name.Contains('\')) { throw 'Unexpected archive root' }
      $parts = $name.TrimEnd('/').Split('/')
      foreach ($part in $parts) {
        if (!$part -or $part -in @('.','..') -or $part -match '[<>:"|?*\x00-\x1f]' -or $part.TrimEnd(' ','.') -ne $part -or $part -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)') { throw 'Invalid archive path' }
      }
      if (!$names.Add($name.TrimEnd('/'))) { throw 'Duplicate archive entry' }
      $type = ($entry.ExternalAttributes -shr 16) -band 61440
      if ($type -eq 40960 -or ($entry.ExternalAttributes -band 1024)) { throw 'Archive link rejected' }
      if ($parts -contains 'chat' -or $parts -contains '.git' -or $parts -contains 'credentials.json' -or $parts -contains 'storage-location.json' -or $parts -contains '.env') { throw 'User data in update archive' }
      $resolved = [IO.Path]::GetFullPath((Join-Path $stage $name.Replace('/', '\')))
      if (!$resolved.StartsWith($stage + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escapes staging directory' }
      $total += $entry.Length
      if ($entry.Length -gt 536870912 -or $total -gt 1610612736) { throw 'Expanded update is too large' }
    }
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    foreach ($entry in $archive.Entries) {
      $file = Join-Path $stage $entry.FullName.Replace('/', '\')
      if ($entry.FullName.EndsWith('/')) { [IO.Directory]::CreateDirectory($file) | Out-Null; continue }
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file)) | Out-Null
      $inputStream = $entry.Open(); $outputStream = [IO.File]::Open($file, [IO.FileMode]::CreateNew)
      try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose(); $inputStream.Dispose() }
    }
  } finally { $archive.Dispose() }
  $prepared = Join-Path $stage $bundleName
  $metadata = [IO.File]::ReadAllText((Join-Path $prepared 'resources/app/package.json')) | ConvertFrom-Json
  if ($metadata.name -ne 'chat-bubble' -or $metadata.version -ne $job.version -or $metadata.main -ne 'dist/main.js') { throw 'Unexpected package metadata' }
  foreach ($required in @('ChatBubble.exe','LICENSE','resources/app/dist/main.js','resources/app/dist/preload.js','resources/app/dist/ui/settings.html')) {
    if (!(Test-Path -LiteralPath (Join-Path $prepared $required) -PathType Leaf)) { throw 'Incomplete update package' }
  }
  # Both resolved paths must stay inside the explicitly selected installation parent.
  if (!$prepared.StartsWith($parentPrefix, [StringComparison]::OrdinalIgnoreCase) -or !$destination.StartsWith($parentPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe move' }
  Move-Item -LiteralPath $prepared -Destination $destination
  [IO.Directory]::Delete($stage, $false)
  Log 'Update verified and staged; old version and user data untouched.'
  exit 0
}
if (!(Test-Path -LiteralPath $newExe -PathType Leaf)) { throw 'Prepared update missing' }
$changed = @()
try {
  # Do not kill a process. Launch only after the app's normal save-and-exit path.
  $process = Get-Process -Id $job.oldPid -ErrorAction SilentlyContinue
  if ($process) { Wait-Process -Id $job.oldPid -Timeout 120 -ErrorAction Stop }
  $shell = New-Object -ComObject WScript.Shell
  foreach ($file in $job.shortcuts) {
    if (![IO.Path]::IsPathRooted($file) -or [IO.Path]::GetExtension($file) -ne '.lnk' -or !(Test-Path -LiteralPath $file -PathType Leaf)) { continue }
    $shortcut = $shell.CreateShortcut($file)
    if (!$shortcut.TargetPath -or ![IO.Path]::GetFullPath($shortcut.TargetPath).Equals($oldExe, [StringComparison]::OrdinalIgnoreCase)) { continue }
    $backup = Join-Path ([IO.Path]::GetDirectoryName($configPath)) ([Guid]::NewGuid().ToString('N') + '.lnk')
    Copy-Item -LiteralPath $file -Destination $backup
    $changed += @{ file=$file; backup=$backup }
    $shortcut.TargetPath=$newExe; $shortcut.WorkingDirectory=$destination; $shortcut.IconLocation=$newExe+',0'; $shortcut.Save()
  }
  $started = Start-Process -FilePath $newExe -WorkingDirectory $destination -WindowStyle Hidden -PassThru
  if ($started.WaitForExit(5000)) { throw 'New application exited during startup' }
  Log 'New version started successfully.'
} catch {
  foreach ($item in $changed) { Copy-Item -LiteralPath $item.backup -Destination $item.file -Force }
  Log 'Launch failed; restoring previous shortcuts and application.'
  if (Test-Path -LiteralPath $oldExe -PathType Leaf) { Start-Process -FilePath $oldExe -WorkingDirectory ([IO.Path]::GetDirectoryName($oldExe)) -WindowStyle Hidden }
  exit 1
}
