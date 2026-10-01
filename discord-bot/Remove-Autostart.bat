@echo off
set "LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Tree Host Discord bot.lnk"
if exist "%LINK%" (del "%LINK%" & echo  The bot will no longer start with Windows.) else (echo  It was not set to start with Windows.)
pause
