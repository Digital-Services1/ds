@echo off
setlocal
cd /d "%~dp0"

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo Node.js and npm were not found.
  pause
  exit /b 1
)

call npm.cmd run build
if errorlevel 1 goto fail
call npm.cmd run test:timeweb
if errorlevel 1 goto fail

where py.exe >nul 2>nul
if not errorlevel 1 goto use_py
where python.exe >nul 2>nul
if not errorlevel 1 goto use_python

echo Python 3 was not found.
pause
exit /b 1

:use_py
py -3 build_data.py
if errorlevel 1 goto fail
py -3 validate_release.py
if errorlevel 1 goto fail
goto success

:use_python
python build_data.py
if errorlevel 1 goto fail
python validate_release.py
if errorlevel 1 goto fail
goto success

:success
echo.
echo RELEASE CHECK PASSED. The folder is ready for local testing and deploy.
pause
exit /b 0

:fail
echo.
echo RELEASE CHECK FAILED. Do not deploy this folder.
pause
exit /b 1
