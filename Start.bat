@echo off
setlocal
title Tree Host (test site)
cd /d "%~dp0"

rem ============ Node.js (installed automatically if missing) ============
where node >nul 2>nul
if not errorlevel 1 goto node_ok
if exist "%ProgramFiles%\nodejs\node.exe" goto node_path
echo.
echo  Node.js is needed and is not installed yet. Installing it now...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install-node.ps1"
if not exist "%ProgramFiles%\nodejs\node.exe" goto node_fail
:node_path
set "PATH=%ProgramFiles%\nodejs;%PATH%"
:node_ok

rem Runs the whole Tree Host website on this PC for testing: sign-ups, plans (fake payments) and servers.
rem It uses its own "test-site-data" folder. The real site runs on the rented Linux server (see README).
set "TREEHOST_PUBLIC_URL=http://localhost:8766"
set "TREEHOST_DATA=%~dp0test-site-data"
set "TREEHOST_GAME_HOST=localhost"
set "BILLING_DEMO=1"
rem With Docker Desktop running, servers run isolated like on the real site.
docker info >nul 2>nul
if not errorlevel 1 set "TREEHOST_ISOLATION=docker"
start "" "http://localhost:8766"
node src\server.js %*
if errorlevel 1 pause
exit /b

:node_fail
echo.
echo  Could not install Node.js automatically.
echo  Install the LTS version from https://nodejs.org, then run Start.bat again.
pause
exit /b 1
