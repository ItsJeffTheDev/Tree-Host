@echo off
rem Starts the Tree Host Discord bot (minimized) every time you log in to Windows.
set "LINK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\Tree Host Discord bot.lnk"
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:LINK); $s.TargetPath='%~dp0Start-Bot.bat'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.Description='Tree Host Discord bot'; $s.Save()"
if exist "%LINK%" (
  echo  Done: the bot will start by itself when you log in to Windows.
  echo  To undo it, run Remove-Autostart.bat.
) else (
  echo  Could not create the startup shortcut.
)
pause
