# claude-nonstop installer for Windows (PowerShell):
#   irm https://raw.githubusercontent.com/umer-jahangier/claude-nonstop/main/install.ps1 | iex
# Installs into %USERPROFILE%\.claude-nonstop\app, adds `claude-nonstop` to your user PATH,
# then runs `claude-nonstop setup`. Re-run it any time to update. No admin rights needed.

& {
  $ErrorActionPreference = 'Stop'
  $Repo = 'umer-jahangier/claude-nonstop'
  $Ref = if ($env:CLAUDE_NONSTOP_REF) { $env:CLAUDE_NONSTOP_REF } else { 'main' }
  $HomeDir = if ($env:CLAUDE_NONSTOP_HOME) { $env:CLAUDE_NONSTOP_HOME } else { Join-Path $env:USERPROFILE '.claude-nonstop' }
  $App = Join-Path $HomeDir 'app'
  $BinDir = Join-Path $HomeDir 'bin'

  # Returning (not exiting) keeps the PowerShell window open when run through `iex`.
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'claude-nonstop install: Node.js 18 or newer is needed. Get it from https://nodejs.org (or: winget install OpenJS.NodeJS.LTS), then run this again.' -ForegroundColor Red
    return
  }
  $major = [int](& node -p "process.versions.node.split('.')[0]")
  if ($major -lt 18) {
    Write-Host "claude-nonstop install: Node.js 18 or newer is needed; this machine has $(& node -v)." -ForegroundColor Red
    return
  }

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("claude-nonstop-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Write-Host "Downloading claude-nonstop ($Ref)..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $zip = Join-Path $tmp 'claude-nonstop.zip'
    Invoke-WebRequest -UseBasicParsing -Uri "https://codeload.github.com/$Repo/zip/$Ref" -OutFile $zip
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    $src = Get-ChildItem -Path $tmp -Directory | Select-Object -First 1
    if (-not $src -or -not (Test-Path (Join-Path $src.FullName 'bin\claude-nonstop.js'))) { throw "the download didn't contain claude-nonstop." }

    New-Item -ItemType Directory -Force -Path $HomeDir | Out-Null
    if (Test-Path $App) { Remove-Item -Path $App -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $App | Out-Null
    foreach ($item in 'bin', 'src', 'package.json', 'README.md', 'LICENSE') {
      Copy-Item -Path (Join-Path $src.FullName $item) -Destination $App -Recurse -Force
    }

    # A launcher next to the app, found through the user PATH by cmd, PowerShell and Git Bash.
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    Set-Content -Path (Join-Path $BinDir 'claude-nonstop.cmd') -Value "@echo off`r`nnode `"%~dp0..\app\bin\claude-nonstop.js`" %*" -Encoding ASCII

    $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    $raw = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    $parts = @($raw -split ';' | Where-Object { $_ })
    if (-not ($parts | Where-Object { $_.TrimEnd('\') -ieq $BinDir.TrimEnd('\') })) {
      $key.SetValue('Path', ((@($BinDir) + $parts) -join ';'), 'ExpandString')
      Add-Type -Namespace ClaudeNonstopInstall -Name Native -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);'
      $result = [UIntPtr]::Zero
      [void][ClaudeNonstopInstall.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
    }
    if (-not (($env:Path -split ';') -contains $BinDir)) { $env:Path = "$BinDir;$env:Path" }

    $script = Join-Path $App 'bin\claude-nonstop.js'
    Write-Host "Installed claude-nonstop $(& node $script --version) to $App"
    Write-Host ''
    $setupArgs = if ($env:CLAUDE_NONSTOP_SETUP_ARGS) { $env:CLAUDE_NONSTOP_SETUP_ARGS -split ' ' } else { @() }
    & node $script setup @setupArgs
    Write-Host ''
    Write-Host 'Open a new terminal to use the claude-nonstop and claude commands.'
  } catch {
    Write-Host "claude-nonstop install: $($_.Exception.Message)" -ForegroundColor Red
  } finally {
    Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
