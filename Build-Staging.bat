@echo off
cd /d "%~dp0"
rem Builds the staging website (public pages only) into the "staging" folder for Wasmer.
rem Start Tree Host first (Start.bat): the pages' data is copied from it.
node tools\build-staging.js %*
if errorlevel 1 (
  pause
  exit /b 1
)
echo.
echo  To publish: open a terminal in the staging folder and run   wasmer deploy
pause
