@echo off
setlocal
cd /d "%~dp0"
echo Installing Node packages...
call npm install
if errorlevel 1 goto :error

echo Installing Chromium for Playwright...
call npx playwright install chromium
if errorlevel 1 goto :error

echo Running KTMB monitor in DRY RUN mode (no email will be sent)...
set DRY_RUN=true
call npm run monitor
pause
exit /b 0

:error
echo.
echo Test failed. Please copy the error shown above.
pause
exit /b 1
