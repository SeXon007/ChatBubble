param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][ValidateSet('valid','traversal','userdata','metadata')][string]$Kind)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$bundle='ChatBubble-0.15.0-win32-x64'
$zip=Join-Path $Root ($Kind+'.zip')
$archive=[IO.Compression.ZipFile]::Open($zip,[IO.Compression.ZipArchiveMode]::Create)
try {
 $files=@{'ChatBubble.exe'='synthetic executable, never run';'LICENSE'='synthetic license';'resources/app/dist/main.js'='fixture';'resources/app/dist/preload.js'='fixture';'resources/app/dist/ui/settings.html'='fixture'}
 $version=if($Kind -eq 'metadata'){'9.9.9'}else{'0.15.0'}
 $files['resources/app/package.json']='{"name":"chat-bubble","version":"'+$version+'","main":"dist/main.js"}'
 if($Kind -eq 'traversal'){$files['../outside.txt']='must not escape'}
 if($Kind -eq 'userdata'){$files['chat/state.json']='must not ship'}
 foreach($name in $files.Keys){$entry=$archive.CreateEntry($bundle+'/'+$name);$writer=[IO.StreamWriter]::new($entry.Open());try{$writer.Write($files[$name])}finally{$writer.Dispose()}}
}finally{$archive.Dispose()}
$zip
