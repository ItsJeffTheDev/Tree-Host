@echo off
setlocal
title Honey Host
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

rem ============ playit.gg (optional: public addresses for players) ============
if exist "%ProgramFiles(x86)%\playit_gg\bin\playit.exe" goto playit_ok
if exist "%ProgramFiles%\playit_gg\bin\playit.exe" goto playit_ok
if exist "%~dp0data\.skip-playit" goto playit_ok
echo.
echo  playit.gg gives your servers free public addresses, so people outside
echo  your home can join without port forwarding.
choice /C YN /M " Install playit.gg now"
if errorlevel 2 goto playit_skip
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install-playit.ps1"
goto playit_ok
:playit_skip
if not exist "%~dp0data" mkdir "%~dp0data"
echo skipped> "%~dp0data\.skip-playit"
echo  OK. You can install it later from https://playit.gg/download
:playit_ok

rem Java for each Minecraft version is downloaded automatically when a server starts.

rem Logins required; reachable from this PC, your home network and a public link.
set MCPT_TEAM=1
set MCPT_TUNNEL=1
node src\server.js %*
if errorlevel 1 pause
exit /b

:node_fail
echo.
echo  Could not install Node.js automatically.
echo  Install the LTS version from https://nodejs.org, then run Start.bat again.
pause
exit /b 1
