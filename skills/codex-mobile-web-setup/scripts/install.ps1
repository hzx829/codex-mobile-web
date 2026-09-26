param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'CodexMobileWeb'),
  [string]$RelayUrl,
  [string]$TokenFile,
  [string]$CodexBin,
  [string]$CodexHome,
  [string]$Version = 'latest',
  [switch]$PrepareOnly
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($env:OS -ne 'Windows_NT' -or [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') {
  throw 'The portable connector requires Windows x64.'
}
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$nodePath = Join-Path $InstallDir 'runtime\node.exe'
$setupPath = Join-Path $InstallDir 'build\setup.mjs'
$startPath = Join-Path $InstallDir 'scripts\windows\start.ps1'
$configPath = Join-Path $InstallDir '.local\config.json'

function Install-Portable {
  $complete = (Test-Path -LiteralPath $nodePath) -and (Test-Path -LiteralPath $setupPath) -and (Test-Path -LiteralPath $startPath)
  if ($complete) { Write-Output 'Reusing the existing installation; no upgrade performed.'; return }
  if ((Test-Path -LiteralPath $InstallDir) -and @(Get-ChildItem -LiteralPath $InstallDir -Force).Count) {
    throw 'InstallDir is nonempty and is not a complete portable installation. Choose a new directory.'
  }
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $headers = @{'User-Agent' = 'codex-mobile-web-setup'; Accept = 'application/vnd.github+json'}
  $releasePath = if ($Version -eq 'latest') { 'latest' } else { 'tags/' + [Uri]::EscapeDataString($Version) }
  $release = Invoke-RestMethod -Uri ('https://api.github.com/repos/hzx829/codex-mobile-web/releases/' + $releasePath) -Headers $headers -TimeoutSec 30
  $archives = @($release.assets | Where-Object { $_.name -match '^codex-mobile-web-[\w.-]+\.zip$' })
  if ($archives.Count -ne 1) { throw 'The release must contain exactly one Windows portable ZIP.' }
  $archive = $archives[0]
  $hashes = @($release.assets | Where-Object { $_.name -eq ($archive.name + '.sha256') })
  if ($hashes.Count -ne 1) { throw 'The release has no matching SHA256 file.' }
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
  $scratch = Join-Path $tempRoot ('cmw-skill-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $scratch | Out-Null
  try {
    $zip = Join-Path $scratch $archive.name
    $hashFile = $zip + '.sha256'
    Invoke-WebRequest -UseBasicParsing -Uri $archive.browser_download_url -OutFile $zip -TimeoutSec 180
    Invoke-WebRequest -UseBasicParsing -Uri $hashes[0].browser_download_url -OutFile $hashFile -TimeoutSec 30
    $hashText = (Get-Content -LiteralPath $hashFile -Raw).Trim()
    if ($hashText -notmatch '^([a-fA-F0-9]{64})\s+(.+)$' -or $Matches[2] -ne $archive.name) { throw 'Invalid SHA256 file.' }
    $expectedHash = $Matches[1]
    if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $expectedHash) { throw 'ZIP SHA256 mismatch; installation aborted.' }
    $unpacked = Join-Path $scratch 'unpacked'
    Expand-Archive -LiteralPath $zip -DestinationPath $unpacked
    $roots = @(Get-ChildItem -LiteralPath $unpacked -Force)
    if ($roots.Count -ne 1 -or -not $roots[0].PSIsContainer) { throw 'Unexpected portable ZIP layout.' }
    $source = $roots[0].FullName
    foreach ($required in @('runtime\node.exe', 'build\setup.mjs', 'scripts\windows\start.ps1', 'VERSION.txt')) {
      if (-not (Test-Path -LiteralPath (Join-Path $source $required) -PathType Leaf)) { throw "Portable ZIP is missing $required" }
    }
    if (Test-Path -LiteralPath (Join-Path $source '.local')) { throw 'Portable ZIP unexpectedly includes local settings.' }
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Get-ChildItem -LiteralPath $source -Force | Copy-Item -Destination $InstallDir -Recurse
    Write-Output ('Installed release ' + $release.tag_name + '; SHA256 verified.')
  } finally {
    $resolvedScratch = [IO.Path]::GetFullPath($scratch)
    if ([IO.Path]::GetDirectoryName($resolvedScratch) -ne $tempRoot -or [IO.Path]::GetFileName($resolvedScratch) -notmatch '^cmw-skill-[a-f0-9]{32}$') {
      throw 'Temporary cleanup path validation failed.'
    }
    Remove-Item -LiteralPath $resolvedScratch -Recurse -Force
  }
}

function Read-LocalToken {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'Codex Mobile Web - Relay Token'
  $form.ClientSize = New-Object System.Drawing.Size(520,170)
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $label = New-Object System.Windows.Forms.Label
  $label.Text = "Paste the Token for $RelayUrl"
  $label.SetBounds(20,20,480,40)
  $field = New-Object System.Windows.Forms.TextBox
  $field.UseSystemPasswordChar = $true
  $field.SetBounds(20,65,480,25)
  $button = New-Object System.Windows.Forms.Button
  $button.Text = 'Connect'
  $button.SetBounds(390,110,110,35)
  $button.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $form.Controls.AddRange(@($label,$field,$button))
  $form.AcceptButton = $button
  try {
    if ($form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { throw 'Token entry cancelled; configuration was not saved.' }
    return $field.Text.Trim()
  } finally { $form.Dispose() }
}

function Save-Settings([hashtable]$Settings) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $nodePath
  $info.Arguments = '"' + $setupPath + '" --settings-stdin'
  $info.WorkingDirectory = $InstallDir
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $info
  try {
    [void]$process.Start()
    $output = $process.StandardOutput.ReadToEndAsync()
    $errors = $process.StandardError.ReadToEndAsync()
    $payload = $Settings | ConvertTo-Json -Compress
    $ascii = [regex]::Replace($payload,'[^\x00-\x7F]',{param($match) '\u'+([int][char]$match.Value).ToString('x4')})
    $process.StandardInput.Write($ascii)
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(20000)) { $process.Kill(); throw 'Codex configuration check timed out.' }
    if ($process.ExitCode -ne 0) { throw ('Configuration failed: ' + $errors.Result.Replace($Settings.token,'[redacted]').Trim()) }
  } finally { $process.Dispose() }
}

Install-Portable
Write-Output ('Installation: ' + $InstallDir)
Get-Content -LiteralPath (Join-Path $InstallDir 'VERSION.txt') | Select-Object -First 4
if ($PrepareOnly) { return }
if (Test-Path -LiteralPath $configPath) {
  try { $saved = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { throw 'Existing config.json is unreadable. Repair it without replacing the Token or machine identity.' }
  if ($saved.mode -ne 'connector') { throw 'This installation is not in connector mode. Use its configure.cmd after finishing tasks.' }
  if (($RelayUrl -and $RelayUrl.TrimEnd('/') -ne $saved.relayUrl.TrimEnd('/')) -or $TokenFile -or $CodexBin -or $CodexHome) {
    throw 'This installation already has settings. Use configure.cmd after finishing tasks to change them.'
  }
} else {
  $relay = $null
  if (-not [Uri]::TryCreate($RelayUrl,[UriKind]::Absolute,[ref]$relay) -or $relay.Scheme -notin @('http','https') -or $relay.AbsolutePath -ne '/' -or $relay.Query -or $relay.Fragment -or $relay.UserInfo) {
    throw 'Supply -RelayUrl with the relay base URL, for example https://codex.example.com.'
  }
  $RelayUrl = $relay.GetLeftPart([UriPartial]::Authority)
  $relayToken = if ($TokenFile) { (Get-Content -LiteralPath $TokenFile -Raw -Encoding UTF8).Trim() } else { Read-LocalToken }
  if ($relayToken.Length -lt 24 -or $relayToken -match '\s') { throw 'Relay Token must contain at least 24 characters and no whitespace.' }
  $settings = @{mode='connector'; relayUrl=$RelayUrl; token=$relayToken}
  if ($CodexBin) { $settings.codexBin = $CodexBin }
  if ($CodexHome) { $settings.codexHome = $CodexHome }
  Save-Settings $settings
  $settings.Clear()
  $relayToken = $null
}
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startPath -NoOpen
if ($LASTEXITCODE -ne 0) { throw 'Connector startup failed. Check .local/connector.error.log in this installation.' }
& $nodePath (Join-Path $PSScriptRoot 'status.mjs') $InstallDir
if ($LASTEXITCODE -ne 0) { throw 'Connection verification failed; setup is incomplete. Existing processes were left running for diagnosis.' }
