'use strict';
// Keeps Windows from going to sleep while Honey Host runs (the screen may still turn off).
// A tiny PowerShell helper holds the "system required" flag and exits when Honey Host exits.
const { spawn } = require('child_process');

function keepAwake() {
  if (process.platform !== 'win32') return null;
  const script = `
Add-Type -Namespace HoneyHost -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
[HoneyHost.Power]::SetThreadExecutionState([uint32]"0x80000001") | Out-Null
while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 20 }
`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    stdio: 'ignore',
  });
  child.on('error', () => {});
  process.on('exit', () => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  });
  return child;
}

module.exports = { keepAwake };
