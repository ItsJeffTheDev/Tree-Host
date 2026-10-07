@echo off
title Tree Host Keep-Alive
color 0A

echo ========================================
echo        TREE HOST KEEP-ALIVE
echo ========================================
echo.
echo Target: https://tree-host.onrender.com/
echo Interval: 50 seconds
echo.
echo Press Ctrl+C to stop.
echo.

:loop
echo [%date% %time%] Sending request...

curl -s -o NUL -w "HTTP Status: %%{http_code}\n" https://tree-host.onrender.com/

echo [%date% %time%] Waiting 50 seconds...
echo.

timeout /t 50 /nobreak >nul
goto loop