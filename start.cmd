@echo off
REM ============================================================
REM  Launch LX Music with a CLEAN environment.
REM
REM  Two env vars MUST be cleared, otherwise the app breaks:
REM
REM    ELECTRON_RUN_AS_NODE  -> Electron runs as plain Node,
REM                             no window ever appears
REM    NODE_OPTIONS          -> WorkBuddy injects a node shim here;
REM                             it breaks fs calls inside the
REM                             Electron main process (mkdirSync
REM                             silently fails -> SQLITE_CANTOPEN)
REM ============================================================

set ELECTRON_RUN_AS_NODE=
set NODE_OPTIONS=
set NODE_ENV=production

cd /d "%~dp0"

echo [%date% %time%] launching... > _start.log

start "" "node_modules\electron\dist\electron.exe" .

echo [%date% %time%] launched. electron processes: >> _start.log
tasklist /FI "IMAGENAME eq electron.exe" /NH >> _start.log 2>&1

echo.
echo   LX Music is starting. The window should appear in a few seconds.
echo.
echo   If it does not appear, send me the file _start.log in this folder.
echo.
timeout /t 4 >nul
