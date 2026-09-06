param([switch]$Disable,[ValidateSet('all','connector')][string]$Mode='connector')
$ErrorActionPreference='Stop'
$projectRoot=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$shortcutPath=Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Mobile Web.lnk'
if($Disable){if(Test-Path -LiteralPath $shortcutPath){Remove-Item -LiteralPath $shortcutPath};Write-Output 'Login startup disabled';exit}
$shell=New-Object -ComObject WScript.Shell
$shortcut=$shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath=(Get-Command powershell.exe).Source
$shortcut.Arguments='-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $PSScriptRoot 'start.ps1')+'" -NoOpen -Mode '+$Mode
$shortcut.WorkingDirectory=$projectRoot
$shortcut.WindowStyle=7
$shortcut.Save()
Write-Output 'Login startup enabled for this Windows user'
