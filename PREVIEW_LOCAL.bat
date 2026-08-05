@echo off
setlocal
cd /d "%~dp0"

where py.exe >nul 2>nul
if not errorlevel 1 goto use_py
where python.exe >nul 2>nul
if not errorlevel 1 goto use_python

echo Python 3 was not found.
echo Install Python 3 and enable the Add Python to PATH option.
pause
exit /b 1

:use_py
echo Updating dashboard data...
py -3 build_data.py
if errorlevel 1 goto fail

echo Validating release...
py -3 validate_release.py
if errorlevel 1 goto fail

echo Starting local server at http://127.0.0.1:8765
start "Photo360 Local Server" cmd /k py -3 -m http.server 8765 --bind 127.0.0.1
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8765/"
echo Nextcloud test: http://127.0.0.1:8765/NEXTCLOUD_TEST.html
exit /b 0

:use_python
echo Updating dashboard data...
python build_data.py
if errorlevel 1 goto fail

echo Validating release...
python validate_release.py
if errorlevel 1 goto fail

echo Starting local server at http://127.0.0.1:8765
start "Photo360 Local Server" cmd /k python -m http.server 8765 --bind 127.0.0.1
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8765/"
echo Nextcloud test: http://127.0.0.1:8765/NEXTCLOUD_TEST.html
exit /b 0

:fail
echo.
echo Release preparation failed. Do not deploy this folder.
pause
exit /b 1
