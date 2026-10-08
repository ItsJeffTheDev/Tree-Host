# Runs a private Tree Host for invited testers on this PC, separate from your own test site.
#  - The dashboard gets a public https://....trycloudflare.com address (a free Cloudflare quick tunnel: no account).
#  - Testers' servers run isolated in Docker, on game ports 26000-26019.
#  - Players join through free playit.gg addresses (one per server, made automatically) when the Tree Host playit
#    agent's key is in <Data>\playit\playit.toml; without it, at this PC's public IP (forward the ports on the router).
#  - Sign-up only works with the tester link (?code=...). Plans are free (demo billing). No Firebase, Stripe or email:
#    accounts and servers stay in the data folder below.
# Run: Start-Testers.bat (or: powershell -ExecutionPolicy Bypass -File tools\Start-Testers.ps1). Ctrl+C stops it.
param(
  [string]$Data = 'D:\tree-host-testers',
  [int]$Port = 8770,
  [string]$GamePorts = '26000-26019',
  [string]$Cloudflared = 'D:\cloudflared\cloudflared.exe',
  [string]$Playitd = 'C:\Program Files\playit_gg\bin\playitd.exe'
)
$ErrorActionPreference = 'Stop'
$App = Split-Path $PSScriptRoot -Parent
New-Item -ItemType Directory -Force $Data | Out-Null

# ---- Docker (testers' servers only run inside it) ----
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Starting Docker Desktop...'
  Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
  for ($i = 0; $i -lt 60; $i++) { Start-Sleep 3; docker info *> $null; if ($LASTEXITCODE -eq 0) { break } }
  if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop did not start. Open it, wait until it says "Engine running", and run this again.' }
}

# ---- The tester code (kept, so links you already sent keep working) ----
$codeFile = Join-Path $Data 'tester-code.txt'
if (-not (Test-Path $codeFile)) {
  $chars = 'abcdefghjkmnpqrstuvwxyz23456789'.ToCharArray()
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $bytes = New-Object byte[] 12
  $rng.GetBytes($bytes)
  (-join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })) | Set-Content -Encoding ascii -NoNewline $codeFile
}
$code = (Get-Content $codeFile -Raw).Trim()

# ---- The address players type in Minecraft: this home connection's public IP ----
$ip = (Invoke-RestMethod -TimeoutSec 15 https://api.ipify.org).Trim()

# ---- The public dashboard address (a new one every time the tunnel starts) ----
$tunnelLog = Join-Path $Data 'tunnel.log'
Remove-Item $tunnelLog -ErrorAction SilentlyContinue
$tunnel = Start-Process -FilePath $Cloudflared -ArgumentList 'tunnel', '--no-autoupdate', '--url', "http://127.0.0.1:$Port", '--logfile', $tunnelLog -WindowStyle Hidden -PassThru
$url = $null
for ($i = 0; $i -lt 60 -and -not $url; $i++) {
  Start-Sleep 1
  if (Test-Path $tunnelLog) {
    $m = Select-String -Path $tunnelLog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
    if ($m) { $url = $m.Matches[0].Value }
  }
}
if (-not $url) { Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue; throw "The Cloudflare tunnel didn't start. See $tunnelLog" }

# ---- playit.gg: a self-managed agent just for Tree Host (your own playit service and its tunnels are separate) ----
$playitKey = Join-Path $Data 'playit\playit.toml'
$agent = $null
if ((Test-Path $playitKey) -and (Test-Path $Playitd)) {
  $agent = Start-Process -FilePath $Playitd -ArgumentList '--secret-path', $playitKey, '--socket-path', '\\.\pipe\playitd-treehost', '--log-path', (Join-Path $Data 'playit\agent.log') -WindowStyle Hidden -PassThru
}

# ---- Only the tester settings: nothing from your own test site (Firebase, Stripe, email keys) ----
Get-ChildItem env: | Where-Object { $_.Name -match '^(TREEHOST_|MCPT_|FIREBASE|STRIPE|RESEND|BILLING_|MAIL_)' } | ForEach-Object { Remove-Item "env:$($_.Name)" }
$env:TREEHOST_PUBLIC_URL = $url
$env:TREEHOST_PORT = "$Port"
$env:TREEHOST_PORTS = $GamePorts
$env:TREEHOST_DATA = $Data
$env:TREEHOST_GAME_HOST = $ip
$env:TREEHOST_ISOLATION = 'docker'
$env:TREEHOST_TRUST_CLOUDFLARE = '1'
$env:TREEHOST_SIGNUP_CODE = $code
$env:BILLING_DEMO = '1'
if ($agent) { $env:TREEHOST_PLAYIT_SECRET_PATH = $playitKey }

$links = @"
Tree Host tester site ($(Get-Date -Format 'yyyy-MM-dd HH:mm'))
  Tester link (send this):  $url/dashboard?code=$code
  Players join at:          $(if ($agent) { 'the playit.gg address on each server''s page' } else { "$ip (each server shows its port, $GamePorts)" })
  The link changes every time this script restarts.
"@
$links | Set-Content -Encoding utf8 (Join-Path $Data 'links.txt')
Write-Host ''
Write-Host $links -ForegroundColor Green
Write-Host ''

try {
  Push-Location $App
  node src/server.js
} finally {
  Pop-Location
  Stop-Process -Id $tunnel.Id -Force -ErrorAction SilentlyContinue
  if ($agent) { Stop-Process -Id $agent.Id -Force -ErrorAction SilentlyContinue }
}
