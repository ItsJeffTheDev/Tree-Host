# Removes the playit.gg app from this PC completely: service, program, saved key, shortcuts,
# and Honey Host's playit link. Agents and tunnels on the playit.gg website are not touched.

# Needs admin rights: relaunch elevated if necessary.
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell.exe -Verb RunAs -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`""
    exit
}

Write-Host ''
Write-Host ' This removes playit.gg from THIS PC:' -ForegroundColor Yellow
Write-Host '   - stops and removes the playit service and app'
Write-Host '   - deletes its saved key, settings, logs and shortcuts'
Write-Host '   - disconnects Honey Host from playit on this PC'
Write-Host ' Your playit.gg account, agents and tunnels on the website are NOT deleted.'
Write-Host ''
if ((Read-Host ' Type YES to continue') -ne 'YES') {
    Write-Host ' Cancelled. Nothing was changed.'
    Read-Host ' Press Enter to close'
    exit
}

# 1. Stop everything playit is running.
Write-Host ' Stopping playit...'
Get-Process -Name playit, playitd, playitd-tray, playitd-service -ErrorAction SilentlyContinue | Stop-Process -Force
if (Get-Service playitd -ErrorAction SilentlyContinue) {
    Stop-Service playitd -Force -ErrorAction SilentlyContinue
}

# 2. Uninstall the app through Windows' own uninstaller entries.
$uninstallKeys = @(
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$apps = Get-ItemProperty $uninstallKeys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'playit*' }
foreach ($app in $apps) {
    Write-Host " Uninstalling $($app.DisplayName)..."
    if ($app.PSChildName -match '^\{[0-9A-Fa-f-]+\}$') {
        Start-Process msiexec.exe -ArgumentList '/x', $app.PSChildName, '/qn', '/norestart' -Wait
    }
    elseif ($app.QuietUninstallString) {
        Start-Process cmd.exe -ArgumentList '/c', $app.QuietUninstallString -Wait
    }
    elseif ($app.UninstallString) {
        Start-Process cmd.exe -ArgumentList '/c', $app.UninstallString -Wait
    }
}

# 3. Remove the service if the uninstaller left it behind.
if (Get-Service playitd -ErrorAction SilentlyContinue) {
    sc.exe delete playitd | Out-Null
}

# 4. Delete leftover folders (program, saved key, settings, logs, shortcuts).
$paths = @(
    "${env:ProgramFiles(x86)}\playit_gg",
    "$env:ProgramFiles\playit_gg",
    "$env:ProgramData\playit_gg",
    "$env:LOCALAPPDATA\playit_gg",
    "$env:APPDATA\playit_gg",
    "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Playit.gg",
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Playit.gg"
)
$paths += Get-ChildItem "$env:ProgramData\Microsoft\Windows\Start Menu\Programs\Startup", "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup" -Filter '*playit*' -ErrorAction SilentlyContinue |
    ForEach-Object { $_.FullName }
foreach ($p in $paths) {
    if ($p -and (Test-Path $p)) {
        Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path $p) { Write-Host "  Could not fully delete $p (something still uses it; restart and run this again)" }
        else { Write-Host "  Deleted $p" }
    }
}

# 5. Disconnect Honey Host from playit on this PC, and let Start.bat offer the install again.
$hhData = Join-Path (Split-Path $PSScriptRoot -Parent) 'data'
foreach ($f in 'playit.json', '.skip-playit') {
    $file = Join-Path $hhData $f
    if (Test-Path $file) { Remove-Item $file -Force; Write-Host "  Removed Honey Host's $f" }
}

Write-Host ''
Write-Host ' playit.gg has been removed from this PC.' -ForegroundColor Green
Write-Host ' To also remove old agents and tunnels, delete them at https://playit.gg/account/agents'
Write-Host ' If Honey Host is running on this PC, restart it.'
Write-Host ''
Read-Host ' Press Enter to close'
