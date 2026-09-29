# Installs the official playit.gg app (signed), makes it start with Windows and opens its one-time setup.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

try {
    $msi = Join-Path $env:TEMP 'playit-windows-x86_64-signed.msi'
    Write-Host ' Downloading playit.gg...'
    Invoke-WebRequest 'https://github.com/playit-cloud/playit-agent/releases/latest/download/playit-windows-x86_64-signed.msi' -OutFile $msi -UseBasicParsing

    Write-Host ' Installing playit.gg (Windows will ask for permission)...'
    Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/passive', '/norestart' -Verb RunAs -Wait
    Remove-Item $msi -ErrorAction SilentlyContinue

    $exe = @("${env:ProgramFiles(x86)}\playit_gg\bin\playit.exe", "$env:ProgramFiles\playit_gg\bin\playit.exe") |
        Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $exe) { throw 'playit was not installed' }

    Write-Host ''
    Write-Host ' A new window opens with a playit.gg link. Open it, sign in (free) and approve.'
    Write-Host ' Then in Honey Host: Team -> Connect.'
    Write-Host ''
    # One elevated window: start playit with Windows, then run its setup.
    $cmd = "sc.exe config playitd start= auto | Out-Null; & '$exe' setup"
    Start-Process powershell.exe -ArgumentList '-NoProfile', '-NoExit', '-Command', $cmd -Verb RunAs
}
catch {
    Write-Host " playit.gg install failed: $($_.Exception.Message)"
    Write-Host ' You can install it yourself from https://playit.gg/download'
}
