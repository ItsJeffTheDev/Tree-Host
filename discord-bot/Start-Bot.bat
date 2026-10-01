@echo off
setlocal
cd /d "%~dp0"

rem ===== Only one copy at a time (two copies would both answer every button) =====
tasklist /v /fi "imagename eq cmd.exe" 2>nul | find /i "Tree Host Discord bot" >nul
if not errorlevel 1 (
  echo  The Tree Host Discord bot is already running in another window.
  timeout /t 5 >nul
  exit /b 0
)
title Tree Host Discord bot

rem ===== Node.js (installed automatically if missing) =====
where node >nul 2>nul
if not errorlevel 1 goto node_ok
if exist "%ProgramFiles%\nodejs\node.exe" goto node_path
echo  Node.js is needed. Installing it now...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\tools\install-node.ps1"
if not exist "%ProgramFiles%\nodejs\node.exe" (
  echo  Could not install Node.js. Install the LTS version from https://nodejs.org and try again.
  pause
  exit /b 1
)
:node_path
set "PATH=%ProgramFiles%\nodejs;%PATH%"
:node_ok

if not exist .env (
  echo.
  echo  No .env file yet. Copy .env.example to .env and fill it in first ^(see README.md^).
  pause
  exit /b 1
)
if not exist node_modules (
  echo  Installing the bot's packages ^(one time^)...
  call npm install --no-fund --no-audit
)
if not exist state.json (
  echo  First run: building the Discord server...
  node src\setup.js
)

rem ===== Run forever: if the bot crashes or the internet drops, start it again =====
:loop
echo.
echo  [%date% %time%] Starting the Tree Host Discord bot. Keep this window open (minimize it). Ctrl+C to stop.
node src\bot.js
echo.
echo  [%date% %time%] The bot stopped. Restarting in 10 seconds... (close this window to stop it for good)
timeout /t 10 /nobreak >nul
goto loop
