# Gives the Honey Host dashboard a permanent, free HTTPS link with Tailscale Funnel.
# Run once on the host PC. Honey Host picks the link up automatically (within 5 minutes, or on its next start).
param([int]$Port = 8766)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ts = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'

function Step($text) { Write-Host ''; Write-Host " $text" -ForegroundColor Yellow }

try {
    # 1. Install Tailscale if needed.
    if (-not (Test-Path $ts)) {
        Step 'Installing Tailscale (free)...'
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            winget install -e --id Tailscale.Tailscale --silent --accept-package-agreements --accept-source-agreements
        }
        if (-not (Test-Path $ts)) {
            $setup = Join-Path $env:TEMP 'tailscale-setup.exe'
            Invoke-WebRequest 'https://pkgs.tailscale.com/stable/tailscale-setup-latest.exe' -OutFile $setup -UseBasicParsing
            Write-Host ' Follow the installer (Windows will ask for permission).'
            Start-Process $setup -Wait
        }
        if (-not (Test-Path $ts)) { throw 'Tailscale was not installed' }
        Start-Sleep -Seconds 5
    }

    # 2. Sign in (a free account; a browser link appears the first time).
    Step 'Signing in to Tailscale. If a link appears below, open it and sign in (free account).'
    & $ts up
    if ($LASTEXITCODE -ne 0) { throw 'Tailscale sign-in did not finish' }

    # 3. Point Funnel at Honey Host. The first time it prints a link to turn Funnel on for your account:
    #    open it, click Enable, and this window continues by itself.
    Step "Creating the permanent link to Honey Host (port $Port)."
    Write-Host ' If a link appears asking to enable HTTPS or Funnel, open it and click Enable.'
    & $ts funnel --bg $Port
    if ($LASTEXITCODE -ne 0) { throw 'Funnel could not be turned on' }

    Step 'Done! Your permanent Honey Host link:'
    & $ts funnel status
    Write-Host ''
    Write-Host ' Honey Host switches to this link automatically within 5 minutes (or when it next starts).' -ForegroundColor Green
    Write-Host ' It keeps working after restarts. To remove it later:  tailscale funnel reset'
}
catch {
    Write-Host ''
    Write-Host " Could not finish: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ' See Help & guides -> Admin guide -> "Permanent dashboard link" for the manual steps.'
}
Write-Host ''
Read-Host ' Press Enter to close'
