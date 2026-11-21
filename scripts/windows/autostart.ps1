param([switch]$Disable,[ValidateSet('auto','all','connector')][string]$Mode='auto')
$ErrorActionPreference='Stop'
$projectRoot=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$shortcutPath=Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Mobile Web.lnk'
if($Disable){if(Test-Path -LiteralPath $shortcutPath){Remove-Item -LiteralPath $shortcutPath};Write-Output 'Login startup disabled';exit}
$shell=New-Object -ComObject WScript.Shell
$shortcut=$shell.CreateShortcut($shortcutPath)
$trayPath=Join-Path $projectRoot 'Codex Mobile Web.exe'
if(Test-Path -LiteralPath $trayPath){
  # Portable package: the tray starts the services quietly and keeps a status icon.
  $shortcut.TargetPath=$trayPath
  $shortcut.Arguments='--background'
} else {
  $shortcut.TargetPath=(Get-Command powershell.exe).Source
  $shortcut.Arguments='-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+(Join-Path $PSScriptRoot 'start.ps1')+'" -NoOpen -Mode '+$Mode
}
$shortcut.WorkingDirectory=$projectRoot
$shortcut.WindowStyle=7
$shortcut.Save()
Write-Output 'Login startup enabled for this Windows user'
