# Installs the current Node.js LTS for Honey Host. Tries winget first, then the official installer.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$nodeExe = Join-Path $env:ProgramFiles 'nodejs\node.exe'

try {
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host ' Installing Node.js LTS with winget...'
        winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
        if (Test-Path $nodeExe) { exit 0 }
    }

    Write-Host ' Downloading Node.js LTS from nodejs.org...'
    $lts = Invoke-RestMethod 'https://nodejs.org/dist/index.json' | Where-Object { $_.lts } | Select-Object -First 1
    $arch = if ([Environment]::Is64BitOperatingSystem) { 'x64' } else { 'x86' }
    $msi = Join-Path $env:TEMP "node-$($lts.version)-$arch.msi"
    Invoke-WebRequest "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-$arch.msi" -OutFile $msi -UseBasicParsing

    Write-Host ' Installing Node.js (Windows will ask for permission)...'
    Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/passive', '/norestart' -Verb RunAs -Wait
    Remove-Item $msi -ErrorAction SilentlyContinue
    if (-not (Test-Path $nodeExe)) { throw 'the installer did not finish' }
    Write-Host ' Node.js installed.'
}
catch {
    Write-Host " Node.js install failed: $($_.Exception.Message)"
    exit 1
}
