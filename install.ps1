# claude-nonstop installer for Windows (PowerShell):
#   irm https://raw.githubusercontent.com/umer-jahangier/claude-nonstop/main/install.ps1 | iex
#
# Brings everything it needs: a private Node.js runtime (checksum-verified, used only by
# claude-nonstop), Claude Code itself if it's missing (Anthropic's official installer),
# and the latest claude-nonstop release. Then it sets everything up. No admin rights are
# needed, and nothing needs running again: claude-nonstop keeps itself up to date.

& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $Repo = 'umer-jahangier/claude-nonstop'
  $HomeDir = if ($env:CLAUDE_NONSTOP_HOME) { $env:CLAUDE_NONSTOP_HOME } else { Join-Path $env:USERPROFILE '.claude-nonstop' }
  $App = Join-Path $HomeDir 'app'
  $Runtime = Join-Path $HomeDir 'runtime'
  $BinDir = Join-Path $HomeDir 'bin'
  $NodeLine = if ($env:CLAUDE_NONSTOP_NODE_LINE) { $env:CLAUDE_NONSTOP_NODE_LINE } else { '22' }
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  function Add-ToUserPath($dir) {
    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    $raw = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    $parts = @($raw -split ';' | Where-Object { $_ })
    if (-not ($parts | Where-Object { $_.TrimEnd('\') -ieq $dir.TrimEnd('\') })) {
      $key.SetValue('Path', ((@($dir) + $parts) -join ';'), 'ExpandString')
      Add-Type -Namespace ClaudeNonstopInstall -Name Native -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);'
      $result = [UIntPtr]::Zero
      [void][ClaudeNonstopInstall.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
    }
    if (-not (($env:Path -split ';') -contains $dir)) { $env:Path = "$dir;$env:Path" }
  }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("claude-nonstop-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null

    # ------------------------------------------------------------------ Node.js
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
    $base = "https://nodejs.org/dist/latest-v$NodeLine.x"
    $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$base/SHASUMS256.txt").Content
    $line = ($sums -split "`n" | Where-Object { $_ -match " node-v[0-9.]+-win-$arch\.zip$" } | Select-Object -First 1).Trim()
    $wantSha = ($line -split '\s+')[0]
    $file = ($line -split '\s+')[-1]
    $version = $file -replace '^node-(v[0-9.]+)-.*$', '$1'
    $nodeExe = Join-Path $Runtime 'node\node.exe'
    $current = if (Test-Path $nodeExe) { (& $nodeExe -v) } else { '' }
    if ($current -ne $version) {
      Write-Host "Downloading Node.js $version for claude-nonstop..."
      $zip = Join-Path $tmp $file
      Invoke-WebRequest -UseBasicParsing -Uri "$base/$file" -OutFile $zip
      if ((Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLower() -ne $wantSha.ToLower()) { throw "the Node.js download didn't match its published checksum." }
      Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp 'node-unpacked') -Force
      $unpacked = Get-ChildItem -Path (Join-Path $tmp 'node-unpacked') -Directory | Select-Object -First 1
      New-Item -ItemType Directory -Force -Path $Runtime | Out-Null
      $target = Join-Path $Runtime 'node'
      if (Test-Path $target) { Remove-Item -Path $target -Recurse -Force }
      Move-Item -Path $unpacked.FullName -Destination $target
    }

    # ------------------------------------------------------------------ Claude Code
    $hasClaude = (Get-Command claude -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $env:USERPROFILE '.local\bin\claude.exe'))
    if (-not $hasClaude -and $env:CLAUDE_NONSTOP_SKIP_CLAUDE -ne '1') {
      Write-Host "Installing Claude Code with Anthropic's official installer..."
      # A separate PowerShell, so nothing in that script can close this window.
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -Command 'irm https://claude.ai/install.ps1 | iex'
      $claudeBin = Join-Path $env:USERPROFILE '.local\bin'
      if (Test-Path (Join-Path $claudeBin 'claude.exe')) { Add-ToUserPath $claudeBin; Write-Host 'Claude Code is installed.' }
      else { Write-Host "! Claude Code couldn't be installed automatically. Get it from https://code.claude.com/docs/en/setup, then run: claude-nonstop setup" -ForegroundColor Yellow }
    }

    # ------------------------------------------------------------------ claude-nonstop
    $ref = $env:CLAUDE_NONSTOP_REF
    if (-not $ref) {
      try { $ref = (Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ 'User-Agent' = 'claude-nonstop' }).tag_name } catch { $ref = $null }
      if (-not $ref) { $ref = 'main' }
    }
    Write-Host "Downloading claude-nonstop ($ref)..."
    $zip = Join-Path $tmp 'claude-nonstop.zip'
    Invoke-WebRequest -UseBasicParsing -Uri "https://codeload.github.com/$Repo/zip/$ref" -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp 'app-unpacked') -Force
    $src = Get-ChildItem -Path (Join-Path $tmp 'app-unpacked') -Directory | Select-Object -First 1
    if (-not $src -or -not (Test-Path (Join-Path $src.FullName 'bin\claude-nonstop.js'))) { throw "the download didn't contain claude-nonstop." }
    if (Test-Path $App) { Remove-Item -Path $App -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $App | Out-Null
    foreach ($item in 'bin', 'src', 'package.json', 'README.md', 'LICENSE') {
      Copy-Item -Path (Join-Path $src.FullName $item) -Destination $App -Recurse -Force
    }

    # The command runs on claude-nonstop's own Node.js, whatever the system has.
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    Set-Content -Path (Join-Path $BinDir 'claude-nonstop.cmd') -Encoding ASCII -Value "@echo off`r`n`"%~dp0..\runtime\node\node.exe`" `"%~dp0..\app\bin\claude-nonstop.js`" %*"
    Add-ToUserPath $BinDir

    $script = Join-Path $App 'bin\claude-nonstop.js'
    Write-Host "Installed claude-nonstop $(& $nodeExe $script --version) to $App"
    Write-Host ''
    $setupArgs = if ($env:CLAUDE_NONSTOP_SETUP_ARGS) { $env:CLAUDE_NONSTOP_SETUP_ARGS -split ' ' } else { @('--yes') }
    & $nodeExe $script setup @setupArgs
    Write-Host ''
    Write-Host 'Open a new terminal to use the claude-nonstop and claude commands.'
  } catch {
    Write-Host "claude-nonstop install: $($_.Exception.Message)" -ForegroundColor Red
  } finally {
    Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
