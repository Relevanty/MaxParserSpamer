@echo off
title MaxParserSpamer
cd /d "%~dp0"

echo ========================================================
echo         MaxParserSpamer - Startup Script
echo ========================================================
echo.

:: Check if Node.js is installed
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in PATH!
    echo Please install Node.js from https://nodejs.org/
    echo.
    pause
    exit /b
)

:: Check if node_modules exists, install dependencies if missing
if not exist "node_modules\" (
    echo [INFO] First time setup: Installing dependencies...
    echo.
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] Failed to install dependencies.
        pause
        exit /b
    )
    echo [INFO] Dependencies installed successfully.
    echo.
)

:: Start the application
echo [INFO] Starting the application...
npm start

pause
