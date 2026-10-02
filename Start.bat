@echo off
setlocal
title Tree Host (test site)
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

rem Runs the whole Tree Host website on this PC for testing: sign-ups, plans and servers.
rem It uses its own "test-site-data" folder. The real site runs on the rented Linux server (see README).

rem ============ Your private settings (optional) ============
rem Put Stripe test keys, admin emails etc. in test-site.env (copy test-site.env.example). It is never committed.
if exist "%~dp0test-site.env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%~dp0test-site.env") do if not "%%b"=="" set "%%a=%%b"
)

set "TREEHOST_PUBLIC_URL=http://localhost:8766"
rem The Owner account (sign in with this email, verified, to get the Owner role)
if not defined TREEHOST_ADMIN_EMAILS set "TREEHOST_ADMIN_EMAILS=daniel@treehost.online"
set "TREEHOST_DATA=%~dp0test-site-data"
if not defined TREEHOST_GAME_HOST set "TREEHOST_GAME_HOST=localhost"

rem ============ Firebase sign-in (the same project as the real site) ============
rem The web config is public by design (every browser gets it). localhost is allowed by Firebase out of the box.
if not defined FIREBASE_API_KEY set "FIREBASE_API_KEY=REDACTED"
if not defined FIREBASE_AUTH_DOMAIN set "FIREBASE_AUTH_DOMAIN=tree-host.firebaseapp.com"
if not defined FIREBASE_PROJECT_ID set "FIREBASE_PROJECT_ID=tree-host"
if not defined FIREBASE_DATABASE_URL set "FIREBASE_DATABASE_URL=https://tree-host-default-rtdb.firebaseio.com"
if not defined FIREBASE_APP_ID set "FIREBASE_APP_ID=1:840029330018:web:96c8dbdde3990b3fdccf3b"
rem With the service account key next to this file, the test site also uses the Realtime Database, in its own
rem "treehost-test" area so test data never mixes with the real site's customers.
if not defined FIREBASE_SERVICE_ACCOUNT_FILE if exist "%~dp0tree-host-firebase.json" set "FIREBASE_SERVICE_ACCOUNT_FILE=%~dp0tree-host-firebase.json"
if not defined FIREBASE_DB_ROOT set "FIREBASE_DB_ROOT=treehost-test"

rem ============ Payments ============
rem With a Stripe TEST key in test-site.env, checkout goes through Stripe (test cards). Without one: fake payments.
if defined STRIPE_SECRET_KEY (
  echo %STRIPE_SECRET_KEY% | findstr /b "sk_live_ rk_live_" >nul && (
    echo.
    echo  test-site.env has a LIVE Stripe key. Use your TEST key ^(sk_test_...^) on this PC.
    pause
    exit /b 1
  )
) else (
  set "BILLING_DEMO=1"
)

rem ============ Server isolation ============
rem Servers run isolated in Docker whenever Docker Desktop is running (checked again every time one starts).
rem Without Docker, this test site runs them directly on this PC; the real site never does.
set "TREEHOST_ISOLATION=auto"

start "" "http://localhost:8766"
node src\server.js %*
if errorlevel 1 pause
exit /b

:node_fail
echo.
echo  Could not install Node.js automatically.
echo  Install the LTS version from https://nodejs.org, then run Start.bat again.
pause
exit /b 1
