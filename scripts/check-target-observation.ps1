# Compile production C# and test its observation state machine only.
# Do not start the watcher, create a window, or invoke any capture API.
$ErrorActionPreference = 'Stop'
$nativeSourcePath = Join-Path $PSScriptRoot '../src/native/window-target.ps1'
$scriptText = Get-Content -LiteralPath $nativeSourcePath -Raw
$classMatch = [regex]::Match($scriptText, '(?s)\$targetSource = @\x27\r?\n(.*?)\r?\n\x27@')
if (-not $classMatch.Success) { throw 'Production C# source not found' }
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition $classMatch.Groups[1].Value
$checks = [ordered]@{}
$windowInfo = '{"handle":"101","pid":731,"width":700,"height":460}'
$checks.firstExternalPublished = $null -ne [ChatBubbleTarget]::Observe(101, $false, $false, $false, $windowInfo)
$checks.nullForegroundDoesNotClear = $null -eq [ChatBubbleTarget]::Observe(0, $false, $false, $false, 'null')
$checks.ownFocusDoesNotClear = $null -eq [ChatBubbleTarget]::Observe(202, $true, $false, $false, 'null')
$checks.taskbarDoesNotClear = $null -eq [ChatBubbleTarget]::Observe(303, $false, $true, $false, 'null')
$checks.sameValidWindowDoesNotRepublish = $null -eq [ChatBubbleTarget]::Observe(101, $false, $false, $false, $windowInfo)
$checks.temporaryUnreadablePublished = $null -ne [ChatBubbleTarget]::Observe(101, $false, $false, $false, 'null')
$checks.sameHandleBecomesReadableAgain = $null -ne [ChatBubbleTarget]::Observe(101, $false, $false, $false, $windowInfo)
$checks.realDesktopClearsTarget = $null -ne [ChatBubbleTarget]::Observe(404, $false, $false, $true, 'null')
$checks.returnFromDesktopRestoresTarget = $null -ne [ChatBubbleTarget]::Observe(101, $false, $false, $false, $windowInfo)
$report = [pscustomobject]@{ checks = $checks; limitation = 'Pure observation state machine; no native window calls or screenshots' }
$report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $PSScriptRoot '../docs/verification/capture-fix-0.8.1/target-observation.json') -Encoding UTF8
$checks | ConvertTo-Json -Compress
if ($checks.Values -contains $false) { throw 'Observation regression failed' }
