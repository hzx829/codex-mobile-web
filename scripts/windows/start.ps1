param([ValidateSet('all','connector','relay')][string]$Mode='all',[switch]$NoOpen)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Set-Location -LiteralPath $projectRoot
$nodePath=Join-Path $projectRoot 'runtime\node.exe'
if(-not(Test-Path -LiteralPath $nodePath)){$nodePath=(Get-Command node -ErrorAction Stop).Source}
if(-not(Test-Path -LiteralPath '.local\config.json')){& $nodePath 'build\setup.mjs';if($LASTEXITCODE -ne 0){throw '配置失败'}}
New-Item -ItemType Directory -Force -Path '.local' | Out-Null
$entries=if($Mode -eq 'all'){@('relay','connector')}else{@($Mode)}
foreach($entry in $entries){
  $modulePath=Join-Path $projectRoot "build\$entry.mjs"
  $pidFile=Join-Path $projectRoot ".local\$entry.pid"
  if(Test-Path -LiteralPath $pidFile){
    $existingId=Get-Content -LiteralPath $pidFile
    if($existingId -notmatch '^\d+$'){throw 'Invalid process record'}
    $existing=Get-CimInstance Win32_Process -Filter "ProcessId=$existingId" -ErrorAction SilentlyContinue
    if($existing -and $existing.CommandLine.Contains($modulePath)){Write-Output "$entry is already running";continue}
  }
  $proc=Start-Process -FilePath $nodePath -ArgumentList @('--disable-warning=ExperimentalWarning',('"'+$modulePath+'"')) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput ".local\$entry.log" -RedirectStandardError ".local\$entry.error.log" -PassThru
  Set-Content -LiteralPath $pidFile -Value $proc.Id
  Write-Output "$entry started"
}
Start-Sleep -Seconds 2
foreach($entry in $entries){
  $entryId=Get-Content -LiteralPath ".local\$entry.pid"
  if(-not(Get-Process -Id $entryId -ErrorAction SilentlyContinue)){throw "$entry failed. See .local\$entry.error.log"}
}
if(-not $NoOpen){Start-Process -FilePath (Join-Path $projectRoot '.local\connect.html')}
