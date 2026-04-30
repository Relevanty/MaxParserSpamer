@echo off
cd /d "%~dp0"
echo Installing dependencies...
call npm install --silent
if errorlevel 1 (
    echo npm install failed. Check your Node.js installation.
    pause
    exit /b 1
)
node tools/start.js
