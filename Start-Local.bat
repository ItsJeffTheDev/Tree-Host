@echo off
setlocal
title Tree Host (local only)
cd /d "%~dp0"

rem For a developer's own PC: no logins, only reachable from this PC, separate data folder.
where node >nul 2>nul
if not errorlevel 1 goto node_ok
if exist "%ProgramFiles%\nodejs\node.exe" goto node_path
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install-node.ps1"
if not exist "%ProgramFiles%\nodejs\node.exe" goto node_fail
:node_path
set "PATH=%ProgramFiles%\nodejs;%PATH%"
:node_ok

set "TREEHOST_DATA=%~dp0local-data"
node src\server.js %*
if errorlevel 1 pause
exit /b

:node_fail
echo  Could not install Node.js automatically. Install it from https://nodejs.org and try again.
pause
exit /b 1
