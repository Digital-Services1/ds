@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0UPDATE_SOURCE_EXCEL.ps1"
if errorlevel 1 (
  echo.
  echo Failed to update the Excel source.
  pause
  exit /b 1
)
exit /b 0
