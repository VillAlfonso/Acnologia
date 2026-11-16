@echo off
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Run npm install before starting BrowserAuto.
  pause
  exit /b 1
)
set ELECTRON_RUN_AS_NODE=
start "BrowserAuto" "node_modules\electron\dist\electron.exe" .
