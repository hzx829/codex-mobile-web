$ErrorActionPreference='Stop'
$projectRoot=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
foreach($entry in @('connector','relay')){
  $pidFile=Join-Path $projectRoot ".local\$entry.pid"
  if(-not(Test-Path -LiteralPath $pidFile)){continue}
  $recordedId=Get-Content -LiteralPath $pidFile
  if($recordedId -notmatch '^\d+$'){throw 'Invalid process record'}
  $proc=Get-CimInstance Win32_Process -Filter "ProcessId=$recordedId" -ErrorAction SilentlyContinue
  $modulePath=Join-Path $projectRoot "build\$entry.mjs"
  if($proc -and $proc.CommandLine -and $proc.CommandLine.Contains($modulePath)){
    # Only this connector's child runtime is stopped; the official desktop is independent.
    if($entry -eq 'connector'){
      Get-CimInstance Win32_Process -Filter "ParentProcessId=$recordedId" | Where-Object {$_.Name -eq 'codex.exe' -and $_.CommandLine -and $_.CommandLine.Contains('app-server')} | ForEach-Object {
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
