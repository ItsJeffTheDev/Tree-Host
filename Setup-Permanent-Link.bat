@echo off
rem Gives the Honey Host dashboard a permanent, free HTTPS link (Tailscale Funnel). Run once on the host PC.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\setup-funnel.ps1" -Port 8766
