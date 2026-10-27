param([Parameter(Mandatory=$true)][string]$Version)
$ErrorActionPreference='Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid version' }
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$name='ChatBubble-'+$Version+'-win32-x64'
$package=Join-Path $root ('release/'+$name)
$zip=Join-Path $root ('release/'+$name+'.zip')
if (!(Test-Path -LiteralPath $package -PathType Container) -or (Test-Path -LiteralPath $zip)) { throw 'Package missing or ZIP already exists' }
if (@(Get-ChildItem -LiteralPath (Join-Path $package 'chat') -Force -ErrorAction SilentlyContinue).Count -gt 0) { throw 'User chat data exists in package' }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[IO.Compression.ZipFile]::Open($zip,[IO.Compression.ZipArchiveMode]::Create)
try {
 foreach($file in Get-ChildItem -LiteralPath $package -Recurse -File) {
  if($file.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Package link rejected'}
  $relative=$file.FullName.Substring($package.Length+1).Replace('\','/')
  if($relative -match '(^|/)(chat|credentials\.json|storage-location\.json|\.env|\.git)(/|$)'){throw 'User data in package'}
  [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive,$file.FullName,$name+'/'+$relative,[IO.Compression.CompressionLevel]::Optimal) | Out-Null
 }
} finally { $archive.Dispose() }
$hash=(Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $root 'release/SHA256SUMS.txt'),$hash+'  '+$name+".zip`n",[Text.UTF8Encoding]::new($false))
Write-Output $zip
