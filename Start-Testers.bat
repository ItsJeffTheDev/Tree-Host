@echo off
rem Private Tree Host for invited testers (public link through a free Cloudflare tunnel). See tools\Start-Testers.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\Start-Testers.ps1" %*
pause
