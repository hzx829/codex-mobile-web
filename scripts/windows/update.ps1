param([switch]$NoPause)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Set-Location -LiteralPath $projectRoot
$exitCode=0
try {
  $nodePath=Join-Path $projectRoot 'runtime\node.exe'
  if(-not(Test-Path -LiteralPath $nodePath)){$nodePath=(Get-Command node -ErrorAction Stop).Source}
  $tsxPath=Join-Path $projectRoot 'node_modules\tsx\dist\cli.mjs'
  if(-not(Test-Path -LiteralPath $tsxPath)){throw '源码目录缺少依赖，请让 Codex 检查安装。'}
  New-Item -ItemType Directory -Force -Path '.local' | Out-Null
  $launcherLog=Join-Path $projectRoot '.local\desktop-update.log'
  Set-Content -LiteralPath $launcherLog -Value ('Started: '+[DateTime]::UtcNow.ToString('o')) -Encoding UTF8
  function Invoke-UpdateCommand([string]$Script,[string[]]$Arguments=@()) {
    $savedPreference=$ErrorActionPreference
    try {
      $ErrorActionPreference='Continue'
      $commandOutput=& $nodePath $tsxPath (Join-Path $projectRoot $Script) @Arguments 2>&1
      $commandCode=$LASTEXITCODE
    } finally {$ErrorActionPreference=$savedPreference}
    $commandOutput | Out-File -LiteralPath $launcherLog -Append -Encoding UTF8
    return $commandCode
  }
  function Read-UpdateResult {
    $startedAt=[DateTime]::UtcNow
    $commandCode=Invoke-UpdateCommand 'scripts\update-check.ts' @('--apply')
    $receipt=Get-Item -LiteralPath '.local\update-check-last.json'
    if($receipt.LastWriteTimeUtc -lt $startedAt.AddSeconds(-1)){throw '未收到本次检查结果，请查看日志。'}
    $result=Get-Content -LiteralPath $receipt.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
    if($commandCode -ne 0 -or $result.status -eq 'failed') {
      if($result.error){throw $result.error}
      throw '适配检查未通过，需要 Codex 修复兼容问题。'
    }
    return $result
  }
  Write-Host '正在检查 Codex Web 更新，请稍候…'
  $result=Read-UpdateResult
  if($result.action -eq 'deploy-connector') {
    Write-Host '检查已通过，正在更新连接器并恢复会话…'
    $commandCode=Invoke-UpdateCommand 'scripts\connector-deploy.ts'
    $deployment=Get-Content -LiteralPath '.local\connector-update-receipt.json' -Raw -Encoding UTF8 | ConvertFrom-Json
    if($deployment.status -eq 'waiting-idle') {
      Write-Host '当前有任务或操作未结束，请结束后再双击运行。'
      return
    }
    if($commandCode -ne 0 -or $deployment.status -eq 'failed'){throw $deployment.error}
    $result=Read-UpdateResult
  }
  if($result.status -eq 'waiting-idle') {
    Write-Host ('暂未切换：'+$result.reason)
    Write-Host '处理完后再双击运行即可。'
  } elseif($result.action -eq 'none') {
    if($result.status -eq 'unchanged'){Write-Host '没有需要更新的内容，当前连接器和网页检查通过。'}
    else {Write-Host '更新完成，连接器和网页检查通过。'}
    Write-Host ('Codex 版本：'+$result.runtime.version)
  } elseif($result.action -eq 'deploy-web') {
    throw '中继网页与通过检查的构建不一致，需要让 Codex 部署网页后再运行。'
  } else {throw '仍需处理兼容问题，请将检查记录交给 Codex。'}
} catch {
  $exitCode=1
  Write-Host ('检查未完成：'+$_.Exception.Message) -ForegroundColor Red
  Write-Host ('详细记录：'+(Join-Path $projectRoot '.local\desktop-update.log'))
  Write-Host ('适配检查日志：'+(Join-Path $projectRoot '.local\update-check.log'))
} finally {
  if(-not $NoPause){Read-Host '按回车关闭窗口' | Out-Null}
}
exit $exitCode
