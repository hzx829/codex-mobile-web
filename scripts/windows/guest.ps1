param([Parameter(Mandatory=$true)][ValidateSet('Start','Stop','Clear')][string]$Action,[switch]$NoStatus)
$ErrorActionPreference='Stop'
$returnFailed=$false
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$root=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$local=Join-Path $root '.local'
$guest=Join-Path $root 'guest'
$pidFile=Join-Path $local 'connector.pid'
$outputLog=Join-Path $local 'connector.log'
$errorLog=Join-Path $local 'connector.error.log'

function Test-Link($item){
  return ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
}

function Remove-GuestItem($item){
  if($item.PSIsContainer){
    if(Test-Link $item){[IO.Directory]::Delete($item.FullName);return}
    foreach($child in (Get-ChildItem -LiteralPath $item.FullName -Force)){Remove-GuestItem $child}
  }
  Remove-Item -LiteralPath $item.FullName -Force
}

# The guest's apps may refresh the owner's login while it is lent; give the refreshed copy back.
function Invoke-ReturnLogin{
  $node=Join-Path $root 'runtime\node.exe'
  if(-not(Test-Path -LiteralPath $node)){$node=(Get-Command node -ErrorAction Stop).Source}
  Push-Location -LiteralPath $root
  try{
    & $node --disable-warning=ExperimentalWarning (Join-Path $root 'build\connector.mjs') --return-login | ForEach-Object {Write-Host $_}
    return ($LASTEXITCODE -eq 0)
  }finally{Pop-Location}
}

function Show-ConnectorLogs{
  $lines=@()
  if(Test-Path -LiteralPath $outputLog){$lines+=Get-Content -LiteralPath $outputLog -Encoding UTF8 -Tail 14}
  if(Test-Path -LiteralPath $errorLog){$lines+=Get-Content -LiteralPath $errorLog -Encoding UTF8 -Tail 4}
  return $lines -join [Environment]::NewLine
}

try{
  $localItem=Get-Item -LiteralPath $local -Force
  if(-not $localItem.PSIsContainer -or (Test-Link $localItem)){throw '访客包的 .local 必须是普通文件夹'}
  $env:BRIDGE_CONFIG=Join-Path $local 'config.json'
  $env:BRIDGE_DATA=$local
  Remove-Item Env:BRIDGE_TOKEN,Env:RELAY_URL -ErrorAction SilentlyContinue
  $config=Get-Content -LiteralPath $env:BRIDGE_CONFIG -Raw -Encoding UTF8 | ConvertFrom-Json
  if($config.guest -ne $true -or $config.guestRoot -or $config.mode -ne 'connector'){throw '访客包配置无效'}
  if($Action -eq 'Clear'){
    if((Read-Host '此操作将删除访客项目、会话和登录副本。输入 YES 确认') -cne 'YES'){exit 0}
  }

  $hasher=[Security.Cryptography.SHA256]::Create()
  try{$key=[BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToUpperInvariant()))).Replace('-','')}
  finally{$hasher.Dispose()}
  $mutex=New-Object Threading.Mutex($false, "Local\CodexMobileGuest-$key")
  $locked=$false
  try{
    try{$locked=$mutex.WaitOne(15000)}catch [Threading.AbandonedMutexException]{$locked=$true}
    if(-not $locked){throw '访客连接器正在执行另一项操作，请稍后重试'}
    if($Action -eq 'Start'){
      & (Join-Path $PSScriptRoot 'start.ps1') -Mode connector -NoOpen
    }else{
      & (Join-Path $PSScriptRoot 'stop.ps1') -Mode connector -Guest
      if(-not (Invoke-ReturnLogin)){
        if($Action -eq 'Clear'){throw '登录没能写回这台电脑，访客数据没有清除。请关闭 Codex 和 Claude Code 后再试一次。'}
        $returnFailed=$true
      }
      if($Action -eq 'Clear'){
        $entry=Get-Item -LiteralPath $guest -Force -ErrorAction SilentlyContinue
        if($entry){
          if([IO.Path]::GetFullPath($entry.FullName) -ne $guest -or $entry.Parent.FullName -ne $root){
            throw '访客数据目录与解压位置不符'
          }
          Remove-GuestItem $entry
        }
        foreach($suffix in @('','-wal','-shm','-journal')){
          $ledger=Join-Path $local "operations.sqlite$suffix"
          if(Test-Path -LiteralPath $ledger -PathType Leaf){Remove-Item -LiteralPath $ledger -Force}
        }
        Write-Host '访客数据已清除。'
      }
    }
  }finally{
    if($locked){$mutex.ReleaseMutex()}
    $mutex.Dispose()
  }

  if($returnFailed){exit 1}
  if($Action -eq 'Stop'){Write-Host '访客连接器已停止。'}
  if($Action -eq 'Start' -and -not $NoStatus){
    Write-Host "电脑名称 $($config.machineName)"
    Write-Host '关闭此窗口后连接器仍会运行。双击「停止.cmd」可以断开。'
    $startedId=Get-Content -LiteralPath $pidFile
    $previous=''
    do{
      $lines=Show-ConnectorLogs
      if($lines -and $lines -ne $previous){Write-Host $lines;$previous=$lines}
      Start-Sleep -Seconds 2
    }while((Test-Path -LiteralPath $pidFile) -and (Get-Content -LiteralPath $pidFile) -eq $startedId -and (Get-Process -Id $startedId -ErrorAction SilentlyContinue))
    $lines=Show-ConnectorLogs
    if($lines -and $lines -ne $previous){Write-Host $lines}
    Write-Host "访客连接器已退出。日志在 $local"
    if(Test-Path -LiteralPath $pidFile){exit 1}
  }
}catch{
  if($Action -eq 'Start'){
    Write-Host (Show-ConnectorLogs)
    Write-Host "日志在 $local"
  }
  Write-Host $_.Exception.Message
  exit 1
}
