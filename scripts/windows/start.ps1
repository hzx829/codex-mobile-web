param([ValidateSet('auto','all','connector','relay')][string]$Mode='auto',[switch]$NoOpen,[switch]$InDetachedTree)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Set-Location -LiteralPath $projectRoot
$nodePath=Join-Path $projectRoot 'runtime\node.exe'
if(-not(Test-Path -LiteralPath $nodePath)){$nodePath=(Get-Command node -ErrorAction Stop).Source}
if(-not(Test-Path -LiteralPath '.local\config.json')){
  if($NoOpen){throw '请先完成连接配置（点击托盘图标，或运行 configure.cmd）'}
  & powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'configure.ps1') -Mode $Mode
  if($LASTEXITCODE -ne 0){throw '配置未完成'}
}
$settings=Get-Content -LiteralPath '.local\config.json' -Raw -Encoding UTF8 | ConvertFrom-Json
if($Mode -eq 'auto'){$Mode=if($settings.mode){$settings.mode}else{'all'}}
if($Mode -notin @('all','connector','relay')){throw '启动方式无效，请重新配置'}
if($settings.guest){
  if($Mode -ne 'connector' -or -not $NoOpen){throw 'Use the guest launcher for this package'}
}elseif(-not $InDetachedTree){
  & $nodePath 'build\setup.mjs' --refresh-page
  if($LASTEXITCODE -ne 0){throw '连接页面生成失败，请检查配置'}
}
New-Item -ItemType Directory -Force -Path '.local' | Out-Null
$entries=if($Mode -eq 'all'){@('relay','connector')}else{@($Mode)}

# Break away from caller Job Objects (e.g. Claude Code Bash / Antigravity run_command KILL_ON_JOB_CLOSE)
# by delegating daemon creation to WMI Win32_Process.Create, which spawns outside the caller's job tree.
if(-not $InDetachedTree -and -not $settings.guest){
  $detachedOk=$false
  try{
    $psExe=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $envBlock=[string[]]@(Get-ChildItem env: | Where-Object {$_.Name -and $_.Name -notlike '=*' -and $null -ne $_.Value} | ForEach-Object {"$($_.Name)=$($_.Value)"})
    $startup=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0;EnvironmentVariables=$envBlock}
    $cmdLine="`"$psExe`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Mode $Mode -NoOpen -InDetachedTree"
    $spawned=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$cmdLine;CurrentDirectory=$projectRoot;ProcessStartupInformation=$startup} -ErrorAction Stop
    if($spawned -and $spawned.ReturnValue -eq 0 -and $spawned.ProcessId){
      $helper=Get-Process -Id ([int]$spawned.ProcessId) -ErrorAction SilentlyContinue
      if($helper){$null=$helper.WaitForExit(25000)}
      $allAlive=$true
      foreach($entry in $entries){
        $pidFile=Join-Path $projectRoot ".local\$entry.pid"
        if(-not(Test-Path -LiteralPath $pidFile)){$allAlive=$false;break}
        $entryId=Get-Content -LiteralPath $pidFile -ErrorAction SilentlyContinue
        if(-not($entryId -match '^\d+$') -or -not(Get-Process -Id ([int]$entryId) -ErrorAction SilentlyContinue)){$allAlive=$false;break}
      }
      if($allAlive){$detachedOk=$true}
    }
  }catch{}
  if($detachedOk){
    foreach($entry in $entries){Write-Output "$entry started"}
    if(-not $NoOpen){Start-Process -FilePath (Join-Path $projectRoot '.local\connect.html')}
    exit 0
  }
}

$processError=if($settings.guest){'Stop'}else{'SilentlyContinue'}
foreach($entry in $entries){
  $modulePath=Join-Path $projectRoot "build\$entry.mjs"
  $pidFile=Join-Path $projectRoot ".local\$entry.pid"
  if(Test-Path -LiteralPath $pidFile){
    $existingId=Get-Content -LiteralPath $pidFile
    if($existingId -notmatch '^\d+$'){throw 'Invalid process record'}
    $existing=Get-CimInstance Win32_Process -Filter "ProcessId=$existingId" -ErrorAction $processError
    if($existing -and $existing.CommandLine -and $existing.CommandLine.Contains($modulePath)){Write-Output "$entry is already running";continue}
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
