param([ValidateSet('all','connector','relay')][string]$Mode='all',[int]$ExpectedPid=0)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$entries=if($Mode -eq 'all'){@('connector','relay')}else{@($Mode)}
foreach($entry in $entries){
  $pidFile=Join-Path $projectRoot ".local\$entry.pid"
  if(-not(Test-Path -LiteralPath $pidFile)){continue}
  $recordedId=Get-Content -LiteralPath $pidFile
  if($recordedId -notmatch '^\d+$'){throw 'Invalid process record'}
  if($entry -eq 'connector' -and $ExpectedPid -and [int]$recordedId -ne $ExpectedPid){throw 'Connector process changed; check again before stopping'}
  $proc=Get-CimInstance Win32_Process -Filter "ProcessId=$recordedId" -ErrorAction SilentlyContinue
  $modulePath=Join-Path $projectRoot "build\$entry.mjs"
  if($proc -and $proc.CommandLine -and $proc.CommandLine.Contains($modulePath)){
    # Only this connector's child runtime is stopped; the official desktop is independent.
    if($entry -eq 'connector'){
      Get-CimInstance Win32_Process -Filter "ParentProcessId=$recordedId" | Where-Object {$_.Name -like 'codex*.exe' -and $_.CommandLine -and $_.CommandLine.Contains('app-server')} | ForEach-Object {
        Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        Wait-Process -Id $_.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
      }
    }
    Stop-Process -Id $recordedId -ErrorAction SilentlyContinue
    Wait-Process -Id $recordedId -Timeout 10 -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $pidFile
}
Write-Output 'Stopped this installation.'
