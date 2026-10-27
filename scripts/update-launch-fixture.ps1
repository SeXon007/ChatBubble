param([Parameter(Mandatory=$true)][string]$Root,[switch]$Fail)
$ErrorActionPreference='Stop'
$old=Join-Path $Root 'ChatBubble-0.14.0-win32-x64'
$new=Join-Path $Root 'ChatBubble-0.15.0-win32-x64'
[IO.Directory]::CreateDirectory($old) | Out-Null
[IO.Directory]::CreateDirectory($new) | Out-Null
$oldCode='using System;using System.IO;using System.Threading;class OldFixture {static void Main(){File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"started.txt"),"old");Thread.Sleep(1000);}}'
$newCode=if($Fail){'class NewFixture {static void Main(){System.Environment.Exit(1);}}'}else{'using System;using System.IO;using System.Threading;class NewFixture {static void Main(){File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"started.txt"),"new");Thread.Sleep(6500);}}'}
Add-Type -TypeDefinition $oldCode -OutputAssembly (Join-Path $old 'ChatBubble.exe') -OutputType ConsoleApplication
Add-Type -TypeDefinition $newCode -OutputAssembly (Join-Path $new 'ChatBubble.exe') -OutputType ConsoleApplication
$shell=New-Object -ComObject WScript.Shell
$shortcut=$shell.CreateShortcut((Join-Path $Root 'ChatBubble.lnk'))
$shortcut.TargetPath=Join-Path $old 'ChatBubble.exe';$shortcut.Save()
