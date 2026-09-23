@echo off
title MaxParserSpamer (Docker)
cd /d "%~dp0"

echo ========================================================
echo         MaxParserSpamer - Docker Startup Script
echo ========================================================
echo.

:: Check if Docker is installed
docker -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Docker is not installed or not running!
    echo Please install Docker Desktop from https://www.docker.com/products/docker-desktop
    echo.
    pause
    exit /b
)

echo [INFO] Starting the application via Docker Compose...
docker-compose run --rm app

pause
