'use strict';

// Adding or removing a folder at the front of the Windows user PATH. The raw registry
// value is edited (keeping %VARIABLES% unexpanded) and running programs are told about
// the change, so new terminals see it right away.

const { spawnSync } = require('child_process');

function script(op, dir) {
  const quoted = dir.replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Stop'
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
$raw = [string]$key.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
$dir = '${quoted}'
$parts = @($raw -split ';' | Where-Object { $_ -and ($_.TrimEnd('\\') -ne $dir.TrimEnd('\\')) })
if ('${op}' -eq 'add') { $parts = @($dir) + $parts }
$key.SetValue('Path', ($parts -join ';'), 'ExpandString')
Add-Type -Namespace ClaudeNonstop -Name Native -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);'
$result = [UIntPtr]::Zero
[void][ClaudeNonstop.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
`;
}

function run(op, dir) {
  const encoded = Buffer.from(script(op, dir), 'utf16le').toString('base64');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
  });
  if (r.error || r.status !== 0) throw new Error(`could not update your PATH: ${(r.stderr || (r.error && r.error.message) || '').trim()}`);
}

function userPath() {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', "[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')"],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 },
  );
  return (r.stdout || '').trim();
}

module.exports = {
  addToUserPath: (dir) => run('add', dir),
  removeFromUserPath: (dir) => run('remove', dir),
  userPath,
};
