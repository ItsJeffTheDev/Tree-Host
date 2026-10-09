@echo off
rem Tree Host Stream Deck: big buttons that get this PC ready to stream (see tools\stream-deck\deck.js).
setlocal
cd /d "%~dp0"
where node >nul 2>nul || set "PATH=%ProgramFiles%\nodejs;%PATH%"

rem Start the deck in its own minimized window, unless it's already running.
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:8790/api/status > $null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  start "Tree Host Stream Deck" /min node "%~dp0tools\stream-deck\deck.js"
  timeout /t 2 /nobreak >nul
)

rem Open it as its own app window (not a tab), sized like a control panel.
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%CHROME%" (
  start "" "%CHROME%" --app=http://127.0.0.1:8790 --window-size=1280,860
) else (
  start "" http://127.0.0.1:8790
)
