@echo off
rem Removes the playit.gg app from this PC completely (asks for admin rights and confirmation first).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\remove-playit.ps1"
