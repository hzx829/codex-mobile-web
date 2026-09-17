param([ValidateSet('auto','all','connector','relay')][string]$Mode='auto')
$ErrorActionPreference='Stop'
$projectRoot=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$nodePath=Join-Path $projectRoot 'runtime\node.exe'
if(-not(Test-Path -LiteralPath $nodePath)){$nodePath=(Get-Command node -ErrorAction Stop).Source}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

function Assert-Stopped {
  foreach($entry in @('connector','relay')) {
    $pidFile=Join-Path $projectRoot ".local\$entry.pid"
    if(-not(Test-Path -LiteralPath $pidFile)){continue}
    $recordedId=Get-Content -LiteralPath $pidFile
    if($recordedId -notmatch '^\d+$'){throw '进程记录无效，请检查 .local 目录。'}
    $proc=Get-CimInstance Win32_Process -Filter "ProcessId=$recordedId" -ErrorAction SilentlyContinue
    if($proc -and $proc.CommandLine -and $proc.CommandLine.Contains((Join-Path $projectRoot "build\$entry.mjs"))){throw '请先完成电脑任务并运行 stop.cmd，再修改连接配置。停止服务会结束连接器管理的任务。'}
  }
}
function Invoke-Setup([string]$SetupArguments,[string]$Payload='') {
  $info=New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName=$nodePath
  $info.Arguments='"'+(Join-Path $projectRoot 'build\setup.mjs')+'" '+$SetupArguments
  $info.WorkingDirectory=$projectRoot
  $info.UseShellExecute=$false
  $info.CreateNoWindow=$true
  $info.RedirectStandardInput=$true
  $info.RedirectStandardOutput=$true
  $info.RedirectStandardError=$true
  $info.StandardOutputEncoding=New-Object System.Text.UTF8Encoding($false)
  $info.StandardErrorEncoding=New-Object System.Text.UTF8Encoding($false)
  $process=New-Object System.Diagnostics.Process
  $process.StartInfo=$info
  try {
    [void]$process.Start()
    $output=$process.StandardOutput.ReadToEndAsync()
    $errors=$process.StandardError.ReadToEndAsync()
    # JSON is ASCII escaped, so Windows stdin encoding cannot corrupt project paths.
    $ascii=[regex]::Replace($Payload,'[^\x00-\x7F]',{param($match) '\u'+([int][char]$match.Value).ToString('x4')})
    $process.StandardInput.Write($ascii)
    $process.StandardInput.Close()
    if(-not $process.WaitForExit(20000)){$process.Kill();throw '配置检查超时，请确认 Codex 可以正常启动。'}
    if($process.ExitCode -ne 0){throw $errors.Result.Trim()}
    return $output.Result
  } finally {$process.Dispose()}
}
try {Assert-Stopped;$settings=(Invoke-Setup '--defaults') | ConvertFrom-Json}
catch {[void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'Codex 随行');exit 1}

$form=New-Object System.Windows.Forms.Form
$form.Text='Codex 随行 · 连接配置'
$form.ClientSize=New-Object System.Drawing.Size(640,580)
$form.MinimumSize=New-Object System.Drawing.Size(600,580)
$form.StartPosition='CenterScreen'
$form.AutoScaleMode='Dpi'
$form.Font=New-Object System.Drawing.Font('Microsoft YaHei UI',10)
$layout=New-Object System.Windows.Forms.TableLayoutPanel
$layout.Dock='Fill';$layout.Padding=New-Object System.Windows.Forms.Padding(24)
$layout.ColumnCount=1;$layout.AutoScroll=$true
$form.Controls.Add($layout)
function Add-Label([string]$Text) {
  $label=New-Object System.Windows.Forms.Label
  $label.Text=$Text;$label.AutoSize=$true;$label.Margin=New-Object System.Windows.Forms.Padding(0,10,0,5)
  $layout.Controls.Add($label)
}
function Add-Path([bool]$Directory) {
  $row=New-Object System.Windows.Forms.TableLayoutPanel
  $row.ColumnCount=2;$row.AutoSize=$true;$row.Dock='Top'
  [void]$row.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Percent',100)))
  [void]$row.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle('Absolute',80)))
  $field=New-Object System.Windows.Forms.TextBox
  $field.Dock='Fill'
  $button=New-Object System.Windows.Forms.Button
  $button.Text='选择…';$button.Dock='Top';$button.Height=32
  $button.Add_Click({
    if($Directory){$dialog=New-Object System.Windows.Forms.FolderBrowserDialog;$dialog.Description='选择电脑上的文件夹'}
    else {$dialog=New-Object System.Windows.Forms.OpenFileDialog;$dialog.Filter='Codex 可执行文件 (codex.exe)|codex.exe|可执行文件 (*.exe)|*.exe'}
    try {if($dialog.ShowDialog() -eq 'OK'){
      $path=if($Directory){$dialog.SelectedPath}else{$dialog.FileName}
      $field.Text=$path
    }} finally {$dialog.Dispose()}
  }.GetNewClosure())
  $row.Controls.Add($field,0,0);$row.Controls.Add($button,1,0);$layout.Controls.Add($row)
  return $field
}
Add-Label '手机通过网页指挥电脑上的 Codex。模型配置继续沿用电脑。'
Add-Label '连接方式'
$modeBox=New-Object System.Windows.Forms.ComboBox
$modeBox.DropDownStyle='DropDownList';$modeBox.Dock='Top'
[void]$modeBox.Items.Add('本机中继（先用同一 Wi-Fi 验证）')
[void]$modeBox.Items.Add('连接自己的中继（已部署的公网地址）')
$selectedMode=if($Mode -eq 'auto'){$settings.mode}else{$Mode}
$modeBox.SelectedIndex=if($selectedMode -eq 'connector'){1}else{0}
$layout.Controls.Add($modeBox)
Add-Label '自动显示这台电脑 Codex 的全部项目和会话，无需选择目录。'
Add-Label '手机可访问的中继地址'
$relay=New-Object System.Windows.Forms.TextBox;$relay.Dock='Top';$relay.Text=$settings.relayUrl;$layout.Controls.Add($relay)
Add-Label '连接 Token（本机首次留空自动生成；公网填写服务器的 Token）'
$token=New-Object System.Windows.Forms.TextBox;$token.Dock='Top';$token.UseSystemPasswordChar=$true;$token.Text=$settings.token;$layout.Controls.Add($token)
Add-Label 'Codex 程序（留空自动识别）'
$bin=Add-Path $false;$bin.Text=$settings.codexBin
Add-Label 'Codex 配置目录（留空沿用当前用户）'
$codexDirectory=Add-Path $true;$codexDirectory.Text=$settings.codexHome
Add-Label '保存后双击 start.cmd 启动。此处不修改模型、Key 或原生会话。'
$save=New-Object System.Windows.Forms.Button;$save.Text='保存配置';$save.Height=40;$save.Dock='Top'
$save.Add_Click({
  $save.Enabled=$false;$form.UseWaitCursor=$true
  try {
    Assert-Stopped
    $payload=@{mode=$(if($modeBox.SelectedIndex -eq 1){'connector'}else{'all'});relayUrl=$relay.Text.Trim();token=$token.Text.Trim();codexBin=$bin.Text.Trim();codexHome=$codexDirectory.Text.Trim()} | ConvertTo-Json -Depth 5 -Compress
    $null=Invoke-Setup '--settings-stdin' $payload
    $form.DialogResult='OK';$form.Close()
  } catch {[void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'配置未保存')}
  finally {$save.Enabled=$true;$form.UseWaitCursor=$false}
})
$layout.Controls.Add($save)
$result=$form.ShowDialog();$form.Dispose()
if($result -ne 'OK'){exit 1}
